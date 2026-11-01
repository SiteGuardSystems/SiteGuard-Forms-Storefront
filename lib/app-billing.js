// SiteGuard App billing rules (Pricing Rev06, 31 Oct 2026): pure functions
// over data/app-billing.json. No I/O, no Stripe, no clock reads -- every
// "now" is passed in, so the founding rules (dates, delay credit, refund of
// the unused prepayment) are unit-testable and the website checkout
// (WP-S9/S10) can reuse them unchanged.
//
// Prices are NOT calculated here (Dan's decision #90, 1 Nov 2026: one price
// source). Every app price -- each cadence's whole-dollar loaded price, the
// founding prepayment, the loadings and the founding discount -- comes from
// data/app-catalogue.json: the catalogue's group "app", written by Hseq-Dev
// docs/build_catalogue.py from docs/pricing/app_price_table.json (its public
// view pinned in pricing.lock; test/pricing-lock.test.js). data/app-billing.json keeps what
// is not a price: dates, founding rules, Stripe intervals, labels, notices.
//
// All amounts are integer cents, A$ ex GST unless named otherwise. GST is
// added by Stripe Tax at checkout (tax_behavior "exclusive").

export const CADENCE_ORDER = ["annual", "six_monthly", "quarterly", "monthly"];

/** A copy of the config with the app catalogue's prices attached: per product
 *  monthly_aud (annual basis), loaded_per_month_aud and prices_cents per
 *  cadence (one billing period) and founding_cents (the founding prepayment
 *  per unit); per cadence its loading; founding.discount. */
function attachPrices(cfg, appCatalogue, problems) {
  const app = appCatalogue?.app;
  const rows = new Map((appCatalogue?.packs ?? []).filter((p) => p.group === "app").map((p) => [p.id, p]));
  if (!app || !rows.size) {
    problems.push("no app catalogue (data/app-catalogue.json, written by Hseq-Dev build_catalogue.py)");
    return cfg;
  }
  if (cfg.pricing_revision !== app.revision) problems.push(`pricing_revision ${cfg.pricing_revision} but the app catalogue is ${app.revision}`);
  if (app.currency !== "AUD" || app.prices_exclude_gst !== true) problems.push("the app catalogue must be A$ ex GST");
  const out = { ...cfg, cadences: {}, products: [] };
  for (const [name, c] of Object.entries(cfg.cadences ?? {})) {
    const loading = name === "annual" ? 0 : app.billing?.loading?.[name];
    if (loading === undefined) problems.push(`cadence ${name}: no loading in the app catalogue`);
    out.cadences[name] = { ...c, loading };
  }
  for (const p of cfg.products ?? []) {
    const row = rows.get(p.id);
    if (!row) { problems.push(`${p.id}: not in the app catalogue`); out.products.push(p); continue; }
    const ap = row.app_prices;
    const prices_cents = {};
    const loaded = {};
    for (const name of CADENCE_ORDER) {
      if (!out.cadences[name]) continue;
      const c = ap.cadences?.[name];
      if (!c || c.months !== out.cadences[name].months) { problems.push(`${p.id} ${name}: no price, or its months differ from the app catalogue`); continue; }
      prices_cents[name] = Math.round(c.per_period * 100);
      loaded[name] = c.per_month;
    }
    out.products.push({ ...p, monthly_aud: ap.per_month, loaded_per_month_aud: loaded, prices_cents, founding_cents: ap.founding_prepay_cents });
  }
  for (const id of rows.keys()) if (!(cfg.products ?? []).some((p) => p.id === id)) problems.push(`${id} is in the app catalogue but not configured`);
  if (cfg.founding) {
    const f = app.founding ?? {};
    out.founding = { ...cfg.founding, discount: f.discount };
    if (cfg.founding.places_total !== f.places) problems.push(`founding.places_total ${cfg.founding.places_total} but the app catalogue says ${f.places}`);
    if (cfg.founding.term_months !== f.term_months) problems.push(`founding.term_months ${cfg.founding.term_months} but the app catalogue says ${f.term_months}`);
  }
  return out;
}

/** Validates data/app-billing.json, attaches the prices from `appCatalogue`
 *  (data/app-catalogue.json; lib/app-prices.js reads it) and returns the
 *  result. Throws on anything that would misprice a checkout, so a bad edit
 *  fails at start-up, not at payment. */
export function validateAppBilling(rawCfg, appCatalogue) {
  const problems = [];
  if (!rawCfg || rawCfg.schema !== 1) problems.push("schema must be 1");
  for (const p of rawCfg?.products ?? []) if ("monthly_aud" in p) problems.push(`${p.id}: prices come from the app catalogue, not monthly_aud here`);
  for (const [name, c] of Object.entries(rawCfg?.cadences ?? {})) if ("loading" in c) problems.push(`cadence ${name}: its loading comes from the app catalogue`);
  if (rawCfg?.founding && "discount" in rawCfg.founding) problems.push("founding.discount comes from the app catalogue");
  const cfg = attachPrices(rawCfg ?? {}, appCatalogue, problems);
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
    if (!(Number.isFinite(p.monthly_aud) && p.monthly_aud > 0)) problems.push(`${p.id}: no monthly price`);
    for (const [name, c] of Object.entries(p.prices_cents ?? {})) if (!(Number.isInteger(c) && c > 0)) problems.push(`${p.id} ${name}: bad price`);
    if (cfg.founding && !(Number.isInteger(p.founding_cents) && p.founding_cents > 0)) problems.push(`${p.id}: no founding prepayment`);
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

/** One billing period's price per cadence, in cents, ex GST, as the app
 *  catalogue states it (the whole-dollar loaded monthly price x months). */
export function pricesFor(_cfg, product) {
  return { ...product.prices_cents };
}

/** The founding prepayment per unit (AUDIT is per seat), as the app catalogue
 *  states it: the first 12 months at the annual price less the founding discount. */
export function foundingAmountCents(_cfg, product) {
  return product.founding_cents;
}

/** Every Stripe price the app needs, from the config alone (no key, no
 *  network): one recurring price per product and cadence, one one-time
 *  founding price per product. scripts/sync-app-stripe.mjs creates exactly
 *  these in Stripe TEST mode; scripts/app-price-list.mjs prints them offline. */
export function stripePriceList(cfg) {
  const out = [];
  for (const p of cfg.products) {
    for (const name of CADENCE_ORDER) {
      const c = cfg.cadences[name];
      if (!c) continue;
      out.push({ app_product_id: p.id, cadence: name, currency: "aud", tax_behavior: "exclusive", unit_amount: p.prices_cents[name],
        recurring: { interval: c.stripe_interval, interval_count: c.stripe_interval_count } });
    }
    if (cfg.founding) out.push({ app_product_id: p.id, cadence: "founding", currency: "aud", tax_behavior: "exclusive", unit_amount: p.founding_cents, recurring: null });
  }
  return out;
}

/** Why the Stripe mapping file can't be used to sell this product on this
 *  cadence (its recorded amount isn't the catalogue's price: re-run
 *  sync-app-stripe), or null. A mapping without recorded amounts is trusted. */
export function stalePriceReason(mapEntry, cadence, expectedCents) {
  const had = mapEntry?.amounts_cents_ex_gst?.[cadence];
  if (had === undefined || had === expectedCents) return null;
  return `the Stripe ${cadence} price on this deployment is ${had} cents but the price list says ${expectedCents}: re-run sync-app-stripe`;
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
    loaded_per_month_aud: { ...p.loaded_per_month_aud },
    prices_cents_ex_gst: pricesFor(cfg, p),
    founding_cents_ex_gst: cfg.founding ? foundingAmountCents(cfg, p) : null,
  }));
}
