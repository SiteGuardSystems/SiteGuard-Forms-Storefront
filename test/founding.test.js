// App billing and the founding offer (Pricing Rev06; Solicitor Brief Rev03 E):
// price maths, dates, delay credit, refund of the unused prepayment, the
// FORMS-pack mapping, the race-safe stock of 20, and the HTTP/webhook flow
// against a fake Stripe client.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/create-app.js";
import {
  validateAppBilling, getProduct, pricesFor, foundingAmountCents, addMonths, monthsBetween,
  delayCreditMonthsDue, unusedPrepaymentCents, matchingFormsPack, checkoutNotice,
} from "../lib/app-billing.js";
import { createFoundingLedger } from "../lib/founding-ledger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(await readFile(path.join(ROOT, "data/app-billing.json"), "utf8"));

/** The shipped config with the sale window open "today" for tests. */
function openConfig(over = {}) {
  const c = structuredClone(CONFIG);
  c.founding.sale_opens_at = "2026-01-01";
  return Object.assign(c, over);
}

const CATALOGUE = {
  schema: 1, preview: false, packs: [
    { id: "compliance:CARP", sellable: true, listed: false },
    { id: "subcontractor:CARP:domestic", sellable: true, listed: true },
    { id: "subcontractor:CARP:light-commercial", sellable: true, listed: true },
    { id: "subcontractor:CARP:heavy-commercial", sellable: true, listed: true },
    { id: "subcontractor:FIN:light-commercial", sellable: true, listed: true },
    { id: "subcontractor:FIN:heavy-commercial", sellable: false, listed: false },
    { id: "compliance:FIN", sellable: true, listed: false },
    { id: "builder:domestic", sellable: true, listed: true },
    { id: "addon:audit", sellable: true, listed: true },
  ],
  documents: [],
  trades: [{ code: "CARP", name: "Carpentry" }, { code: "FIN", name: "Interior Finishes" }],
};

const STRIPE_MAP = {
  mode: "test",
  byProductId: Object.fromEntries(CONFIG.products.map((p) => [p.id, {
    stripe_product_id: `prod_${p.id}`,
    prices: { annual: `price_${p.id}_annual`, six_monthly: `price_${p.id}_6m`, quarterly: `price_${p.id}_q`, monthly: `price_${p.id}_m`, founding: `price_${p.id}_founding` },
  }])),
};

describe("app prices (Pricing Rev06 workbook)", () => {
  const cfg = validateAppBilling(structuredClone(CONFIG));
  test("monthly list prices match Launch Line-up / Trade Packages / App Bundles / Levers", () => {
    assert.deepEqual(cfg.products.map((p) => p.monthly_aud), [196, 271, 496, 910, 1279, 1757, 75]);
    assert.equal(cfg.default_cadence, "annual");
    assert.equal(cfg.cadences.monthly.loading, 0.08);
    assert.equal(cfg.cadences.quarterly.loading, 0.05);
    assert.equal(cfg.cadences.six_monthly.loading, 0.03);
    assert.equal(cfg.app_go_live_date, "2027-06-01");
  });
  test("cadence prices: annual = 12 x monthly; loadings on the shorter periods (cents, ex GST)", () => {
    assert.deepEqual(pricesFor(cfg, getProduct(cfg, "app:trade:domestic")), { annual: 235200, six_monthly: 121128, quarterly: 61740, monthly: 21168 });
    assert.deepEqual(pricesFor(cfg, getProduct(cfg, "app:builder:heavy-commercial")), { annual: 2108400, six_monthly: 1085826, quarterly: 553455, monthly: 189756 });
    assert.equal(pricesFor(cfg, getProduct(cfg, "app:audit:seat")).annual, 90000);
  });
  test("founding price: 12 months less 15%", () => {
    assert.equal(foundingAmountCents(cfg, getProduct(cfg, "app:trade:domestic")), 199920);
    assert.equal(foundingAmountCents(cfg, getProduct(cfg, "app:builder:domestic")), 928200);
    assert.equal(foundingAmountCents(cfg, getProduct(cfg, "app:audit:seat")), 76500);
  });
  test("gated products are refused by the config check", () => {
    const bad = structuredClone(CONFIG);
    bad.products.push({ id: "app:core:documents", group: "core", name: "x", monthly_aud: 1, per: "account" });
    bad.founding.forms_pack_grant["app:core:documents"] = { rule: "fixed", pack: "x" };
    assert.throws(() => validateAppBilling(bad), /gated/);
  });
  test("checkout notice carries the terms version and the price-rise clause, marked PENDING SOLICITOR", () => {
    const n = checkoutNotice(cfg, "founding");
    assert.match(n.text, /^PENDING SOLICITOR/);
    assert.match(n.text, /once a year/);
    assert.match(n.text, new RegExp(n.terms_version.replace(/[()]/g, "\\$&")));
    assert.ok(n.text.length <= 1200);
    assert.doesNotMatch(JSON.stringify(cfg.checkout_notice), /\b(compliant|certified|guaranteed)\b/i);
  });
});

describe("founding dates, delay credit and refund", () => {
  const cfg = structuredClone(CONFIG);
  test("calendar months", () => {
    assert.equal(addMonths("2027-06-01", 12), "2028-06-01");
    assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
    assert.equal(monthsBetween("2027-06-01", "2027-08-01"), 2);
    assert.equal(monthsBetween("2027-06-01", "2027-08-02"), 3, "a part month rounds up");
    assert.equal(monthsBetween("2027-06-01", "2027-05-01"), 0);
  });
  test("one free month per month of delay", () => {
    assert.equal(delayCreditMonthsDue(cfg, "2027-06-01", "2027-06-01"), 0);
    assert.equal(delayCreditMonthsDue(cfg, "2027-06-01", "2027-08-01"), 2);
    assert.equal(delayCreditMonthsDue(cfg, "2027-06-01", "2027-06-15"), 1);
  });
  test("refund of the unused prepayment", () => {
    const sale = { amount_paid_total_cents: 219912, expected_start_date: "2027-06-01", refunds: [] };
    assert.equal(unusedPrepaymentCents(cfg, sale, "2027-03-15"), 219912, "before go-live: all of it");
    const mid = unusedPrepaymentCents(cfg, sale, "2027-12-01");
    assert.ok(mid > 0 && mid < 219912 / 2 + 2000 && mid > 219912 / 2 - 2000, `about half after six months, got ${mid}`);
    assert.equal(unusedPrepaymentCents(cfg, sale, "2028-06-01"), 0, "nothing after the paid term");
    assert.equal(unusedPrepaymentCents(cfg, { ...sale, refunds: [{ amount_cents: 219912 }] }, "2027-03-15"), 0, "never twice");
  });
});

describe("matching FORMS pack", () => {
  const cfg = structuredClone(CONFIG);
  test("mapping", () => {
    assert.equal(matchingFormsPack(cfg, "app:trade:domestic", "CARP", CATALOGUE).packId, "compliance:CARP");
    assert.equal(matchingFormsPack(cfg, "app:trade:light-commercial", "CARP", CATALOGUE).packId, "subcontractor:CARP:light-commercial");
    assert.equal(matchingFormsPack(cfg, "app:trade:heavy-commercial", "CARP", CATALOGUE).packId, "subcontractor:CARP:heavy-commercial");
    assert.equal(matchingFormsPack(cfg, "app:builder:domestic", null, CATALOGUE).packId, "builder:domestic");
    assert.equal(matchingFormsPack(cfg, "app:audit:seat", null, CATALOGUE).packId, "addon:audit");
  });
  test("a level the trade has no pack for falls back to the next level down", () => {
    const m = matchingFormsPack(cfg, "app:trade:heavy-commercial", "FIN", CATALOGUE);
    assert.equal(m.packId, "subcontractor:FIN:light-commercial");
    assert.equal(m.fallback, true);
  });
  test("a trade package needs a trade", () => {
    assert.equal(matchingFormsPack(cfg, "app:trade:domestic", null, CATALOGUE), null);
  });
});

describe("founding ledger: the stock of 20", () => {
  async function ledgerAt(t = new Date("2027-03-10T00:00:00Z")) {
    const dir = await mkdtemp(path.join(tmpdir(), "founding-ledger-"));
    const cfg = openConfig();
    const clock = { t };
    return { clock, ledger: createFoundingLedger({ file: path.join(dir, "ledger.json"), getConfig: () => cfg, now: () => clock.t }) };
  }
  test("25 concurrent reservations: exactly 20 succeed (no oversell)", async () => {
    const { ledger } = await ledgerAt();
    const results = await Promise.all(Array.from({ length: 25 }, () => ledger.reserve({ productId: "app:builder:domestic", quantity: 1, minutes: 35 })));
    assert.equal(results.filter((r) => r.ok).length, 20);
    assert.equal(results.filter((r) => !r.ok).length, 5);
    const s = await ledger.status();
    assert.equal(s.places_remaining, 0);
    assert.equal(s.open, false);
  });
  test("an expired reservation gives its place back", async () => {
    const { ledger, clock } = await ledgerAt();
    for (let i = 0; i < 20; i++) await ledger.reserve({ productId: "app:builder:domestic", quantity: 1, minutes: 35 });
    assert.equal((await ledger.reserve({ productId: "app:builder:domestic", quantity: 1, minutes: 35 })).ok, false);
    clock.t = new Date(clock.t.getTime() + 36 * 60_000);
    assert.equal((await ledger.status()).places_remaining, 20);
  });
  test("closed before the sale opens and on go-live", async () => {
    const { ledger } = await ledgerAt(new Date("2026-11-01T00:00:00Z"));
    const dir = await mkdtemp(path.join(tmpdir(), "founding-ledger-"));
    const shipped = createFoundingLedger({ file: path.join(dir, "l.json"), getConfig: () => CONFIG, now: () => new Date("2026-11-01T00:00:00Z") });
    assert.match((await shipped.status()).closed_reason, /open on 2027-03-01/);
    const late = createFoundingLedger({ file: path.join(dir, "l2.json"), getConfig: () => CONFIG, now: () => new Date("2027-06-02T00:00:00Z") });
    assert.match((await late.status()).closed_reason, /closed/);
    assert.equal((await ledger.status()).open, true);
  });
});

// ---------------- HTTP + webhook ----------------

function makeFakeStripe() {
  const calls = { sessions: [], expired: [], subs: [], subUpdates: [], refunds: [], cancels: [] };
  let n = 0;
  const sessions = new Map();
  return {
    calls,
    sessions,
    checkout: {
      sessions: {
        create: async (p) => {
          n += 1;
          const s = { id: `cs_test_f${n}`, url: `https://checkout.stripe.com/c/cs_test_f${n}`, status: "open", metadata: p.metadata, params: p };
          calls.sessions.push(p);
          sessions.set(s.id, s);
          return s;
        },
        retrieve: async (id) => sessions.get(id),
        expire: async (id) => { calls.expired.push(id); sessions.get(id).status = "expired"; return sessions.get(id); },
        listLineItems: async () => ({ data: [] }),
      },
    },
    paymentIntents: { retrieve: async (id) => ({ id, payment_method: "pm_card_visa_x", amount: 219912 }) },
    subscriptions: {
      create: async (p) => { calls.subs.push(p); return { id: `sub_${calls.subs.length}`, status: "trialing" }; },
      update: async (id, p) => { calls.subUpdates.push({ id, ...p }); return { id }; },
      cancel: async (id) => { calls.cancels.push(id); return { id, status: "canceled" }; },
    },
    refunds: { create: async (p) => { calls.refunds.push(p); return { id: `re_${calls.refunds.length}`, status: "succeeded" }; } },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) },
  };
}

// WP-S10: app_status gates founding ("presale") and subscriptions ("live").
async function withFoundingApp(fn, { config = openConfig(), now, appStatus = "presale", launch = { live: false } } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "founding-app-"));
  const catalogPath = path.join(dir, "catalogue.json");
  const configPath = path.join(dir, "app-billing.json");
  const mapPath = path.join(dir, "app-billing-stripe.test.json");
  await writeFile(catalogPath, JSON.stringify(CATALOGUE));
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(mapPath, JSON.stringify(STRIPE_MAP));
  const stripe = makeFakeStripe();
  const intake = [];
  const clock = { t: now ?? new Date("2027-03-10T00:00:00Z") };
  const app = createApp({
    catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
    stripeWebhookSecret: "whsec_test", publicOrigin: "http://localhost:4300",
    mailer: { configured: false }, leadAllowedOrigins: ["https://www.siteguardsystems.com.au"],
    orderIntakeUrl: "http://intake.test/api/v3/storefront-orders", orderIntakeApiKey: "k",
    fetchImpl: async (url, init) => { intake.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({ id: "o1" }) }; },
    appBillingPath: configPath, appBillingStripePath: mapPath, foundingAdminToken: "admin-token-123", appStatus, launchState: async () => launch,
    now: () => clock.t,
    trustProxy: true,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (p, headers = {}) => fetch(base + p, { headers });
  const setConfig = async (c) => { await writeFile(configPath, JSON.stringify(c)); const t = new Date(Date.now() + 5000); await utimes(configPath, t, t); };
  try {
    await fn({ base, post, get, stripe, intake, clock, dir, setConfig, config });
  } finally {
    server.close();
  }
}

const TERMS = CONFIG.checkout_notice.terms_version;
const buy = (post, over = {}, headers = {}) => post("/api/founding/checkout", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: TERMS, ...over }, headers);

function completedEvent(session, over = {}) {
  return {
    id: `evt_${session.id}`,
    type: "checkout.session.completed",
    data: { object: {
      id: session.id, object: "checkout.session", payment_status: "paid", status: "complete", metadata: session.metadata,
      customer: "cus_test_1", payment_intent: "pi_test_1", currency: "aud", created: 1804550400,
      amount_subtotal: 199920, amount_total: 219912, total_details: { amount_tax: 19992, amount_discount: 0 },
      customer_details: { email: "delivered@resend.dev" },
      custom_fields: [{ key: "client_name", text: { value: "Test Carpentry Pty Ltd" } }, { key: "project_address", text: { value: "1 Test St, Sydney NSW" } }],
      ...over,
    } },
  };
}

describe("founding checkout over HTTP", () => {
  test("status, then a checkout that reserves a place and builds the Stripe session from config", async () => {
    await withFoundingApp(async ({ get, post, stripe }) => {
      const st = await (await get("/api/founding/status")).json();
      assert.equal(st.places_total, 20);
      assert.equal(st.places_remaining, 20);
      assert.equal(st.open, true);
      assert.equal(st.app_go_live_date, "2027-06-01");
      assert.equal(st.notice.status, "PENDING SOLICITOR");
      const r = await buy(post);
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.places_remaining, 19);
      const p = stripe.calls.sessions[0];
      assert.equal(p.mode, "payment");
      assert.deepEqual(p.line_items, [{ price: "price_app:trade:domestic_founding", quantity: 1 }]);
      assert.equal(p.automatic_tax.enabled, true);
      assert.equal(p.metadata.kind, "founding");
      assert.equal(p.metadata.expected_start_date, "2027-06-01");
      assert.equal(p.metadata.forms_pack_id, "compliance:CARP");
      assert.equal(p.metadata.founding_price_cents_ex_gst, "199920");
      assert.equal(p.metadata.terms_version, TERMS);
      assert.match(p.custom_text.submit.message, /PENDING SOLICITOR/);
      assert.equal(p.payment_intent_data.setup_future_usage, "off_session");
      assert.ok(p.expires_at - Math.floor(new Date("2027-03-10T00:00:00Z").getTime() / 1000) === 30 * 60);
    });
  });

  test("refusals: terms not accepted, stale terms version, unknown trade, before the sale opens", async () => {
    await withFoundingApp(async ({ post }) => {
      assert.equal((await buy(post, { acceptedTerms: false })).status, 400);
      assert.equal((await buy(post, { termsVersion: "old" })).status, 409);
      assert.equal((await buy(post, { trade: "ZZZ" })).status, 400);
      assert.equal((await buy(post, { productId: "app:core:documents" })).status, 404);
    });
    await withFoundingApp(async ({ post }) => {
      const r = await buy(post);
      assert.equal(r.status, 409);
      assert.match((await r.json()).reason, /open on 2027-03-01/);
    }, { config: structuredClone(CONFIG), now: new Date("2026-11-01T00:00:00Z") });
  });

  test("the 21st founding purchase is refused, and 30 concurrent checkouts sell at most 20", async () => {
    await withFoundingApp(async ({ post, stripe }) => {
      // 30 buyers on 30 connections at once (distinct client addresses, so the per-IP rate limit doesn't decide it)
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        buy(post, { productId: "app:builder:domestic", trade: undefined }, { "X-Forwarded-For": `203.0.113.${i + 1}` })));
      assert.equal(results.filter((r) => r.status === 200).length, 20);
      assert.equal(results.filter((r) => r.status === 409).length, 10);
      assert.equal(stripe.calls.sessions.length, 20);
      const refused = await buy(post, { productId: "app:builder:domestic", trade: undefined }, { "X-Forwarded-For": "203.0.113.200" });
      assert.equal(refused.status, 409, "the 21st is refused");
      assert.match((await refused.json()).reason, /founding place/i);
    });
  });

  test("an expired Stripe session releases its place; the cancel route expires the session", async () => {
    await withFoundingApp(async ({ post, get, stripe }) => {
      const b1 = await (await buy(post)).json();
      const b2 = await (await buy(post)).json();
      assert.equal((await (await get("/api/founding/status")).json()).places_remaining, 18);
      const s1 = stripe.sessions.get(b1.session_id);
      const ev = { id: "evt_x", type: "checkout.session.expired", data: { object: { id: s1.id, metadata: s1.metadata } } };
      assert.equal((await post("/api/webhook/stripe", ev)).status, 200);
      assert.equal((await (await get("/api/founding/status")).json()).places_remaining, 19);
      const c = await (await post("/api/founding/checkout/cancel", { session_id: b2.session_id })).json();
      assert.equal(c.released, true);
      assert.deepEqual(stripe.calls.expired, [b2.session_id]);
      assert.equal((await (await get("/api/founding/status")).json()).places_remaining, 20);
    });
  });

  test("a paid founding sale: record, renewal subscription, FORMS grant; then a 2-month delay and a refund", async () => {
    await withFoundingApp(async ({ post, get, stripe, intake, clock, setConfig, config }) => {
      const b = await (await buy(post)).json();
      const s = stripe.sessions.get(b.session_id);
      const r = await post("/api/webhook/stripe", completedEvent(s));
      assert.equal(r.status, 200);
      assert.equal((await r.json()).founding_sale_id, "FND-0001");
      // redelivery is a no-op
      assert.equal((await post("/api/webhook/stripe", completedEvent(s))).status, 200);
      assert.equal(stripe.calls.subs.length, 1);
      assert.equal(intake.length, 1);

      const sub = stripe.calls.subs[0];
      assert.deepEqual(sub.items, [{ price: "price_app:trade:domestic_annual", quantity: 1 }]);
      assert.equal(sub.default_payment_method, "pm_card_visa_x");
      assert.equal(new Date(sub.trial_end * 1000 + 10 * 3_600_000).toISOString().slice(0, 10), "2028-06-01");
      assert.deepEqual({ packageId: intake[0].packageId, option: intake[0].option, amountTotal: intake[0].amountTotal }, { packageId: "compliance:CARP", option: "founding-grant", amountTotal: 0 });

      const admin = { Authorization: "Bearer admin-token-123" };
      assert.equal((await get("/api/founding/admin/sales")).status, 401);
      let sales = (await (await get("/api/founding/admin/sales", admin)).json()).sales;
      const sale = sales[0];
      for (const k of ["price_paid_cents_ex_gst", "gst_cents", "amount_paid_total_cents", "expected_start_date", "terms_version", "price_rise_clause_version", "delay_credits", "refunds", "forms_pack", "stripe_subscription_id"]) {
        assert.ok(k in sale, `record has ${k}`);
      }
      assert.equal(sale.price_paid_cents_ex_gst, 199920);
      assert.equal(sale.expected_start_date, "2027-06-01");
      assert.equal(sale.service_end_date, "2028-06-01");
      assert.equal(sale.forms_pack.intake, "recorded");

      const status = await (await get("/api/founding/status")).json();
      assert.equal(status.places_sold, 1);
      assert.equal(status.places_remaining, 19);
      assert.deepEqual(await (await get("/api/founding/places")).json(), { remaining: 19, total: 20, sold: 1, open: true });
      const feed = await (await get("/api/founding/feed")).json();
      assert.deepEqual(feed.figures.founding_places_sold, { "2027-03": 1 });
      assert.deepEqual(feed.figures.founding_places_remaining, { "2027-03": 19 });

      // go-live moves two months: credit applied automatically on the next read
      await setConfig({ ...config, app_go_live_date: "2027-08-01" });
      sales = (await (await get("/api/founding/admin/sales", admin)).json()).sales;
      assert.equal(sales[0].expected_start_date, "2027-08-01");
      assert.deepEqual(sales[0].delay_credits.map((c) => c.months), [2]);
      assert.equal(sales[0].service_end_date, "2028-10-01", "12 paid months from the new go-live plus 2 free months");
      assert.equal(stripe.calls.subUpdates.length, 1);
      assert.equal(new Date(stripe.calls.subUpdates[0].trial_end * 1000 + 10 * 3_600_000).toISOString().slice(0, 10), "2028-10-01");
      // applying again adds nothing
      await post("/api/founding/admin/apply-go-live", {}, admin);
      sales = (await (await get("/api/founding/admin/sales", admin)).json()).sales;
      assert.deepEqual(sales[0].delay_credits.map((c) => c.months), [2]);

      // refund of the unused prepayment, before go-live: all of it
      clock.t = new Date("2027-04-01T00:00:00Z");
      const rf = await (await post("/api/founding/admin/refund", { sale_id: "FND-0001", reason: "delay" }, admin)).json();
      assert.equal(rf.ok, true);
      assert.equal(rf.refund.amount_cents, 219912);
      assert.equal(stripe.calls.refunds[0].payment_intent, "pi_test_1");
      assert.deepEqual(stripe.calls.cancels, ["sub_1"]);
      assert.equal(rf.sale.status, "refunded");
      assert.equal((await post("/api/founding/admin/refund", { sale_id: "FND-0001" }, admin)).status, 409);
    });
  });

  test("app subscriptions stay closed until go-live and app_subscriptions_open", async () => {
    await withFoundingApp(async ({ post }) => {
      const r = await post("/api/subscribe", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: TERMS });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "APP_NOT_OPEN");
    });
    await withFoundingApp(async ({ post, stripe }) => {
      const r = await post("/api/subscribe", { productId: "app:audit:seat", quantity: 3, acceptedTerms: true, termsVersion: TERMS });
      assert.equal(r.status, 200);
      const p = stripe.calls.sessions[0];
      assert.equal(p.mode, "subscription");
      assert.deepEqual(p.line_items, [{ price: "price_app:audit:seat_annual", quantity: 3 }], "annual is the default");
      assert.equal(p.subscription_data.metadata.period_amount_cents_ex_gst, String(90000 * 3));
    }, { config: openConfig({ app_subscriptions_open: true }), now: new Date("2027-06-02T00:00:00Z"), appStatus: "live", launch: { live: true } });
  });

  test("admin routes are off without a token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "founding-noadmin-"));
    await writeFile(path.join(dir, "c.json"), JSON.stringify(CATALOGUE));
    await writeFile(path.join(dir, "a.json"), JSON.stringify(openConfig()));
    const app = createApp({ catalogPath: path.join(dir, "c.json"), varDir: path.join(dir, "var"), publicDir: null, stripe: null,
      publicOrigin: "http://x", mailer: { configured: false }, appBillingPath: path.join(dir, "a.json"), appBillingStripePath: path.join(dir, "none.json") });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/founding/admin/sales`, { headers: { Authorization: "Bearer " } });
      assert.equal(r.status, 404);
    } finally { server.close(); }
  });
});
