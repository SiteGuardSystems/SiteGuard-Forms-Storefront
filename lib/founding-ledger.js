// Founding places: the stock of 20, reservations and the per-sale records.
//
// Race safety: one storefront process owns this file. Every read-modify-write
// runs inside one in-process queue (`serial`), so two checkouts arriving
// together are decided one after the other: a place is RESERVED when the
// Stripe session is created and only then counts against the stock. A
// reservation is released when Stripe says the session expired, when the
// buyer cancels, or when its own TTL lapses (a little longer than the Stripe
// session's 30 minutes). sold + live reservations can never exceed the stock.
// Running more than one storefront process against one ledger is NOT safe;
// move this to a database row lock first (see docs/FOUNDING_OFFER.md).
//
// The file is written atomically (temp file + rename) so a crash mid-write
// leaves the previous ledger intact.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addMonths, delayCreditMonthsDue } from "./app-billing.js";

const EMPTY = () => ({ schema: 1, reservations: [], sales: [], history: [] });

export function monthKey(date, timeZone = "Australia/Sydney") {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
}

export function todayIn(date, timeZone = "Australia/Sydney") {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function createFoundingLedger({ file, getConfig, now = () => new Date() }) {
  let queue = Promise.resolve();
  /** Runs fn(state) with exclusive access; persists if fn returns { save: true }. */
  function serial(fn) {
    const run = queue.then(async () => {
      const state = await load();
      sweep(state);
      const out = await fn(state);
      await save(state);
      return out;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function load() {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return EMPTY();
      throw err; // a corrupt ledger must stop sales, not reset the stock
    }
  }

  async function save(state) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  }

  /** Drops reservations whose TTL has lapsed. */
  function sweep(state) {
    const t = now().toISOString();
    for (const r of state.reservations) {
      if (r.status === "held" && r.expires_at <= t) {
        r.status = "released";
        r.released_reason = "ttl";
        r.released_at = t;
      }
    }
    // keep the file small: forget released reservations after 7 days
    const cutoff = new Date(now().getTime() - 7 * 86_400_000).toISOString();
    state.reservations = state.reservations.filter((r) => r.status === "held" || (r.released_at ?? r.created_at) > cutoff);
  }

  function counts(state) {
    const cfg = getConfig();
    const f = cfg.founding;
    const sold = state.sales.filter((s) => !(f.refund_reopens_place && s.status === "refunded")).length;
    const reserved = state.reservations.filter((r) => r.status === "held").length;
    return { places_total: f.places_total, places_sold: sold, places_reserved: reserved, places_remaining: Math.max(0, f.places_total - sold - reserved) };
  }

  function openState(state) {
    const cfg = getConfig();
    const f = cfg.founding;
    const c = counts(state);
    const today = todayIn(now());
    const closesAt = f.sale_closes_at ?? cfg.app_go_live_date;
    let reason = null;
    if (!f.enabled) reason = "The founding offer is not open.";
    else if (today < f.sale_opens_at) reason = `Founding places open on ${f.sale_opens_at}.`;
    else if (today >= closesAt) reason = "The founding offer has closed.";
    else if (c.places_sold >= f.places_total) reason = "All founding places have been taken.";
    else if (c.places_remaining === 0) reason = "Every remaining founding place is in someone's checkout right now. Try again in half an hour.";
    return { ...c, open: reason === null, closed_reason: reason, sale_opens_at: f.sale_opens_at, sale_closes_at: closesAt };
  }

  return {
    file,
    status: () => serial((state) => openState(state)),

    /** Reserves one place, or says why not. */
    reserve: ({ productId, trade, quantity, minutes }) =>
      serial((state) => {
        const s = openState(state);
        if (!s.open) return { ok: false, reason: s.closed_reason, status: s };
        const t = now();
        const r = {
          id: `res_${randomUUID()}`,
          status: "held",
          product_id: productId,
          trade: trade ?? null,
          quantity,
          created_at: t.toISOString(),
          expires_at: new Date(t.getTime() + minutes * 60_000).toISOString(),
          stripe_session_id: null,
        };
        state.reservations.push(r);
        return { ok: true, reservation: r, status: openState(state) };
      }),

    attachSession: (reservationId, sessionId) =>
      serial((state) => {
        const r = state.reservations.find((x) => x.id === reservationId);
        if (r) r.stripe_session_id = sessionId;
        return r ?? null;
      }),

    /** Releases a held reservation by id or by Stripe session id. */
    release: ({ reservationId, sessionId, reason }) =>
      serial((state) => {
        const r = state.reservations.find((x) => (reservationId && x.id === reservationId) || (sessionId && x.stripe_session_id === sessionId));
        if (!r || r.status !== "held") return { released: false };
        r.status = "released";
        r.released_reason = reason;
        r.released_at = now().toISOString();
        return { released: true, reservation: r };
      }),

    /** Turns a paid session into a sale. Idempotent on the Stripe session id.
     *  A paid sale is ALWAYS recorded (the customer has paid); if its
     *  reservation had lapsed and the stock is gone, it is flagged
     *  `oversold` for Dan rather than refused. */
    confirmSale: ({ reservationId, sessionId, build }) =>
      serial((state) => {
        const existing = state.sales.find((s) => s.stripe_session_id === sessionId);
        if (existing) return { sale: existing, created: false };
        const r = state.reservations.find((x) => x.id === reservationId);
        const held = r?.status === "held";
        const before = counts(state);
        if (r) {
          r.status = "converted";
          r.released_at = now().toISOString();
        }
        const cfg = getConfig();
        const oversold = !held && before.places_sold + before.places_reserved >= cfg.founding.places_total;
        const n = state.sales.length + 1;
        const sale = build({ saleId: `FND-${String(n).padStart(4, "0")}`, oversold });
        state.sales.push(sale);
        return { sale, created: true };
      }),

    updateSale: (saleId, fn) =>
      serial(async (state) => {
        const sale = state.sales.find((s) => s.sale_id === saleId || s.stripe_session_id === saleId);
        if (!sale) return null;
        await fn(sale);
        return sale;
      }),

    sales: () => serial((state) => state.sales.map((s) => structuredClone(s))),

    /** Applies the delay credit automatically: every active sale is moved to
     *  the current go-live date and credited the months of delay since its
     *  ORIGINAL expected start (one free month per month, part months up).
     *  Idempotent: only the difference from credits already given is added.
     *  Returns the changes so the caller can push them to Stripe. */
    applyGoLive: (goLive) =>
      serial((state) => {
        const cfg = getConfig();
        const changes = [];
        const at = now().toISOString();
        for (const sale of state.sales) {
          if (sale.status === "refunded") continue;
          const due = delayCreditMonthsDue(cfg, sale.original_expected_start_date, goLive);
          const given = sale.delay_credits.reduce((s, c) => s + c.months, 0);
          const startMoved = sale.expected_start_date !== goLive && goLive > sale.expected_start_date;
          if (due > given || startMoved) {
            const add = Math.max(0, due - given);
            if (add > 0) {
              sale.delay_credits.push({ months: add, from_start: sale.expected_start_date, to_start: goLive, applied_at: at, basis: "1 free month per month of delay (part months round up)" });
            }
            sale.expected_start_date = goLive;
            const credits = given + add;
            sale.service_end_date = addMonths(goLive, cfg.founding.term_months + credits);
            changes.push({ sale_id: sale.sale_id, credit_months_added: add, credit_months_total: credits, expected_start_date: goLive, service_end_date: sale.service_end_date, stripe_subscription_id: sale.stripe_subscription_id ?? null });
          }
          const longStop = cfg.founding.long_stop_date;
          sale.long_stop_passed = Boolean(longStop && goLive > longStop);
        }
        if (changes.length) state.history.push({ at, event: "go_live_applied", go_live: goLive, sales_changed: changes.length });
        return changes;
      }),

    /** Monthly figures for the Control Console Action gates page, in the
     *  shape siteguard-ai reads: {"figures": {"<figure>": {"YYYY-MM": n}}}.
     *  Each month carries the position at the end of that month (the current
     *  month: as of now), from the first sale month (or this month) on. */
    feed: () =>
      serial((state) => {
        const cfg = getConfig();
        const total = cfg.founding.places_total;
        const reopen = cfg.founding.refund_reopens_place;
        const thisMonth = monthKey(now());
        const months = new Set([thisMonth]);
        for (const s of state.sales) months.add(monthKey(new Date(s.paid_at)));
        const sorted = [...months].sort();
        const first = sorted[0];
        const keys = [];
        for (let k = first; k <= thisMonth; ) {
          keys.push(k);
          const [y, m] = k.split("-").map(Number);
          k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
        }
        const sold = {};
        const remaining = {};
        for (const k of keys) {
          const n = state.sales.filter((s) => monthKey(new Date(s.paid_at)) <= k && !(reopen && s.status === "refunded" && monthKey(new Date(s.refunds?.at(-1)?.at ?? s.paid_at)) <= k)).length;
          sold[k] = n;
          remaining[k] = Math.max(0, total - n);
        }
        return {
          figures: { founding_places_sold: sold, founding_places_remaining: remaining },
          places_total: total,
          generated_at: now().toISOString(),
          source: "siteguard-forms-storefront /api/founding/feed",
        };
      }),
  };
}
