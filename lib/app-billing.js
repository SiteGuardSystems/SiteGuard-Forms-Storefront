// SiteGuard App billing rules (Pricing Rev06, 31 Oct 2026): pure functions
// over data/app-billing.json. No I/O, no Stripe, no clock reads -- every
// "now" is passed in, so the founding rules (dates, delay credit, refund of
// the unused prepayment) are unit-testable and the website checkout
// (WP-S9/S10) can reuse them unchanged.
//
// All amounts are integer cents, A$ ex GST unless named otherwise. GST is
// added by Stripe Tax at checkout (tax_behavior "exclusive").

export const CADENCE_ORDER = ["annual", "six_monthly", "quarterly", "monthly"];

/** Validates the config and returns it. Throws on anything that would
 *  misprice a checkout, so a bad edit fails at start-up, not at payment. */
export function validateAppBilling(cfg) {
  const problems = [];
  if (!cfg || cfg.schema !== 1) problems.push("schema must be 1");
  if (cfg?.currency !== "AUD") problems.push("currency must be AUD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg?.app_go_live_date ?? "")) problems.push("app_go_live_date must be YYYY-MM-DD");
  if (!cfg?.cadences?.[cfg?.default_cadence]) problems.push("default_cadence must name a cadence");
  for (const [name, c] of Object.entries(cfg?.cadences ?? {})) {
    if (!(c.months > 0) || !(c.loading >= 0 && c.loading < 1)) problems.push(`cadence ${name}: bad months/loading`);
  }
  const ids = new Set();
  for (const p of cfg?.products ?? []) {
    if (!p.id || ids.has(p.id)) problems.push(`product id missing or repeated: ${p.id}`);
    ids.add(p.id);
    if (!(Number.isFinite(p.monthly_aud) && p.monthly_aud > 0)) problems.push(`${p.id}: monthly_aud must be > 0`);
    if (/\b(core|ai|robot|robotics|nz|new zealand|overseas|singapore)\b/i.test(`${p.id} ${p.group}`)) {
      problems.push(`${p.id}: gated products are never configured for sale here`);
    }
  }
  const f = cfg?.founding;
  if (f) {
    if (!(Number.isInteger(f.places_total) && f.places_total > 0)) problems.push("founding.places_total must be a positive integer");
    if (!(f.discount > 0 && f.discount < 1)) problems.push("founding.discount must be between 0 and 1");
    if (!(Number.isInteger(f.term_months) && f.term_months > 0)) problems.push("founding.term_months must be a positive integer");
    for (const p of cfg.products ?? []) if (!f.forms_pack_grant?.[p.id]) problems.push(`founding.forms_pack_grant has no rule for ${p.id}`);
  }
  if (problems.length) throw new Error(`data/app-billing.json: ${problems.join("; ")}`);
  return cfg;
}

export function getProduct(cfg, productId) {
  return cfg.products.find((p) => p.id === productId) ?? null;
}

/** One billing period's price for a cadence, in cents, ex GST:
 *  monthly price x months in the period x (1 + loading). Exact to the cent. */
export function periodAmountCents(product, cadence) {
  if (!cadence) throw new Error("unknown cadence");
  return Math.round(product.monthly_aud * 100 * cadence.months * (1 + cadence.loading));
}

export function pricesFor(cfg, product) {
  const out = {};
  for (const name of CADENCE_ORDER) {
    if (cfg.cadences[name]) out[name] = periodAmountCents(product, cfg.cadences[name]);
  }
  return out;
}

/** Founding prepayment: 12 months at the annual (no loading) price, less the
 *  founding discount. Per unit (AUDIT is per seat). */
export function foundingAmountCents(cfg, product) {
  const f = cfg.founding;
  return Math.round(product.monthly_aud * 100 * f.term_months * (1 - f.discount));
}

// ---- dates (calendar dates as YYYY-MM-DD strings, UTC-free arithmetic) ----

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) throw new Error(`bad date: ${s}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}
function fmt({ y, m, d }) {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Adds whole calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date, months) {
  const { y, m, d } = parseDate(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

/** Whole months from `from` to `to` (0 if `to` is not later). A part month
 *  counts as a full month when round = "up" (customer-favourable default). */
export function monthsBetween(from, to, round = "up") {
  if (to <= from) return 0;
  let n = 0;
  while (addMonths(from, n + 1) <= to) n += 1;
  if (round === "up" && addMonths(from, n) < to) n += 1;
  return n;
}

export function daysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** A sale's service window: starts at go-live, runs the paid term plus every
 *  delay-credit month. */
export function serviceWindow(cfg, startDate, creditMonths = 0) {
  return { start: startDate, end: addMonths(startDate, cfg.founding.term_months + creditMonths) };
}

/** Delay-credit months owed for a sale whose original expected start was
 *  `originalStart` when go-live is now `currentGoLive`. Never negative: if
 *  go-live comes forward again, credits already given are kept. */
export function delayCreditMonthsDue(cfg, originalStart, currentGoLive) {
  const rule = cfg.founding.delay_credit ?? { months_per_month_of_delay: 1, part_month_rounds: "up" };
  return monthsBetween(originalStart, currentGoLive, rule.part_month_rounds) * rule.months_per_month_of_delay;
}

/** Refund of the unused prepayment, in cents of what the customer paid
 *  (GST inclusive, since that is what is refunded to the card).
 *    - before the service starts: all of it;
 *    - after: the unused share of the paid term, pro rata by day. Delay-credit
 *      months are free and sit after the paid term, so they never reduce a refund;
 *    - after the paid term: nothing.
 *  Wording and method are PENDING SOLICITOR (question 28). */
export function unusedPrepaymentCents(cfg, sale, today) {
  const total = sale.amount_paid_total_cents;
  const already = (sale.refunds ?? []).reduce((s, r) => s + r.amount_cents, 0);
  const start = sale.expected_start_date;
  const paidEnd = addMonths(start, cfg.founding.term_months);
  let unused;
  if (today <= start) unused = total;
  else if (today >= paidEnd) unused = 0;
  else {
    const days = daysBetween(start, paidEnd);
    unused = Math.floor((total * (days - daysBetween(start, today))) / days);
  }
  return Math.max(0, unused - already);
}

/** The FORMS pack a founding buyer is granted free from purchase.
 *  `catalogue` is data/catalogue.json (packs with id + sellable). Falls back
 *  to the same trade's nearest sellable pack when the exact one isn't on sale
 *  (e.g. a level with no documents of its own for that trade). Returns
 *  { packId, rule, fallback } or null when nothing sensible exists. */
export function matchingFormsPack(cfg, productId, trade, catalogue) {
  const rule = cfg.founding?.forms_pack_grant?.[productId];
  if (!rule) return null;
  const sellable = (id) => {
    const p = catalogue?.packs?.find((x) => x.id === id);
    return Boolean(p && p.sellable);
  };
  if (rule.rule === "fixed") return { packId: rule.pack, rule: rule.rule, fallback: false, sellable: sellable(rule.pack) };
  if (!trade) return null;
  const levels = ["domestic", "light-commercial", "heavy-commercial"];
  const candidates =
    rule.rule === "trade_compliance"
      ? [`compliance:${trade}`, `subcontractor:${trade}:domestic`, `subcontractor:${trade}:light-commercial`]
      : [
          `subcontractor:${trade}:${rule.level}`,
          // the next level down has the same or fewer documents; then the trade's compliance pack
          ...levels.slice(0, levels.indexOf(rule.level)).reverse().map((l) => `subcontractor:${trade}:${l}`),
          `compliance:${trade}`,
        ];
  const hit = candidates.find(sellable);
  if (!hit) return null;
  return { packId: hit, rule: rule.rule, fallback: hit !== candidates[0], sellable: true };
}

/** The checkout notice for a founding or subscription checkout, from config.
 *  Stripe's custom_text is capped at 1,200 characters. */
export function checkoutNotice(cfg, kind) {
  const n = cfg.checkout_notice;
  const body = kind === "founding" ? n.founding_notice_text : n.subscription_notice_text;
  const text = `${body} ${n.price_rise_clause_text} Terms: ${n.terms_version}.`;
  return {
    status: n.status,
    terms_version: n.terms_version,
    price_rise_clause_version: n.price_rise_clause_version,
    price_rise_clause_text: n.price_rise_clause_text,
    text: text.slice(0, 1200),
  };
}

/** Public description of the app line-up: what a pricing page or the
 *  founding page needs, nothing internal. */
export function publicLineUp(cfg) {
  return cfg.products.map((p) => ({
    id: p.id,
    group: p.group,
    name: p.name,
    per: p.per,
    needs_trade: p.needs_trade,
    monthly_aud: p.monthly_aud,
    prices_cents_ex_gst: pricesFor(cfg, p),
    founding_cents_ex_gst: cfg.founding ? foundingAmountCents(cfg, p) : null,
  }));
}
