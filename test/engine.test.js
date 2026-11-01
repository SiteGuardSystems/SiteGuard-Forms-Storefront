// WP-S9 / WP-S10: one checkout engine for both sites. Stripe is mocked (no key
// is used); webhooks are signed with a local test secret by the real stripe
// library's test-header helper and verified by its constructEvent.
//
// Cases: a FORMS one-off from the Systems site, an app annual subscription, a
// founding purchase, the 21st refused, a non-allowlisted origin refused; the
// returnOrigin allowlist, source_site on every session, the app_status +
// P2 + platform-launch gates, and webhook routing by line metadata. (The
// FORMS subscription link-out is a link to the FORMS app's signup, tested on
// siteguard-website.)
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { createApp } from "../lib/create-app.js";
import { appGates, classifySession, makeLaunchCheck, makeOriginPolicy } from "../lib/engine-origins.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(await readFile(path.join(ROOT, "data/app-billing.json"), "utf8"));
const TERMS = CONFIG.checkout_notice.terms_version;
const SUB_TERMS = CONFIG.checkout_notice.terms_version;
const FORMS = "http://localhost:4300";
const SYSTEMS = "https://www.siteguardsystems.com.au";
const EVIL = "https://evil.example";
const WHSEC = "whsec_local_test_secret";
// The real library's signature code, with a placeholder key: nothing is sent to Stripe.
const realStripe = new Stripe("sk_test_placeholder_not_a_key");

const CATALOGUE = {
  schema: 1, preview: false,
  packs: [
    { id: "builder:domestic", name: "Builder Domestic", group: "builder-packs", sellable: true, listed: true, show: true, purchasable: true, count: 2, documents: ["A", "B"], prices: { one_off: 2199, annual: 2749, monthly: 265 } },
    { id: "compliance:CARP", sellable: true, listed: false, prices: { one_off: 1, annual: 1, monthly: 1 }, documents: [] },
    { id: "addon:audit", sellable: true, listed: true, prices: { one_off: 1, annual: 1, monthly: 1 }, documents: [] },
  ],
  documents: [{ code: "SAF-FRM-GEN-001", title: "Form", sellable: true, price: 44 }],
  trades: [{ code: "CARP", name: "Carpentry" }],
};
const MAP = { mode: "test", byProductId: Object.fromEntries(CONFIG.products.map((p) => [p.id, { prices: { annual: `price_${p.id}_annual`, monthly: `price_${p.id}_m`, quarterly: `price_${p.id}_q`, six_monthly: `price_${p.id}_6m`, founding: `price_${p.id}_founding` } }])) };

function fakeStripe() {
  const calls = { sessions: [] };
  const sessions = new Map();
  let n = 0;
  return {
    calls, sessions,
    checkout: { sessions: {
      create: async (p) => { n += 1; const s = { id: `cs_test_e${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_e${n}`, status: "open", metadata: p.metadata, params: p }; calls.sessions.push(p); sessions.set(s.id, s); return s; },
      retrieve: async (id) => sessions.get(id),
      expire: async (id) => sessions.get(id),
      listLineItems: async (id) => ({ data: (sessions.get(id)?.params.line_items ?? []).map((l) => ({ quantity: 1, amount_total: l.price_data?.unit_amount ?? 0, description: l.price_data?.product_data?.name, price: { product: { metadata: l.price_data?.product_data?.metadata ?? {} } } })) }),
    } },
    paymentIntents: { retrieve: async (id) => ({ id, payment_method: "pm_x", amount: 1 }) },
    subscriptions: { create: async () => ({ id: "sub_1", status: "trialing" }), update: async (id) => ({ id }), cancel: async (id) => ({ id }) },
    refunds: { create: async () => ({ id: "re_1" }) },
    webhooks: realStripe.webhooks,
  };
}

async function withEngine(fn, { appStatus = "presale", launch = { live: false }, config = {}, now = new Date("2027-03-10T00:00:00Z") } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "engine-"));
  const cfg = { ...structuredClone(CONFIG), ...config };
  cfg.founding = { ...cfg.founding, sale_opens_at: "2027-03-01", ...(config.founding ?? {}) };
  await writeFile(path.join(dir, "catalogue.json"), JSON.stringify(CATALOGUE));
  await writeFile(path.join(dir, "app-billing.json"), JSON.stringify(cfg));
  await writeFile(path.join(dir, "map.json"), JSON.stringify(MAP));
  const stripe = fakeStripe();
  const app = createApp({
    catalogPath: path.join(dir, "catalogue.json"), varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
    stripeWebhookSecret: WHSEC, publicOrigin: FORMS, mailer: { configured: false },
    leadAllowedOrigins: [SYSTEMS], appStatus, launchState: async () => launch,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ id: "o1" }) }),
    orderIntakeUrl: "http://intake.test/api", orderIntakeApiKey: "k",
    appBillingPath: path.join(dir, "app-billing.json"), appBillingStripePath: path.join(dir, "map.json"),
    now: () => now, trustProxy: true,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const preflight = (p, origin) => fetch(base + p, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  const webhook = (event) => {
    const payload = JSON.stringify(event);
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    return fetch(base + "/api/webhook/stripe", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body: payload });
  };
  const varFile = async (f) => (await readFile(path.join(dir, "var", f), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  try { await fn({ post, preflight, webhook, stripe, varFile, base, dir }); } finally { server.close(); }
}

const completed = (s, over = {}) => ({ id: `evt_${s.id}`, type: "checkout.session.completed", data: { object: {
  id: s.id, object: "checkout.session", payment_status: "paid", status: "complete", metadata: s.metadata, customer: "cus_1", payment_intent: "pi_1",
  subscription: s.params.mode === "subscription" ? "sub_9" : null, currency: "aud", created: 1804550400, amount_subtotal: 219900, amount_total: 241890,
  total_details: { amount_tax: 21990 }, customer_details: { email: "delivered@resend.dev", name: "Test" },
  custom_fields: [{ key: "client_name", text: { value: "Test Pty Ltd" } }, { key: "project_address", text: { value: "1 Test St" } }], ...over } } });

const fromSystems = { Origin: SYSTEMS };
const formsCart = { cart: [{ packageId: "builder:domestic" }], acceptedTerms: true, termsVersion: "SG-LEGAL-02 v0.4; SG-LEGAL-01 v0.4", returnOrigin: SYSTEMS, source_site: "systems" };

describe("WP-S9: /api/checkout for two sites", () => {
  test("a FORMS one-off from the Systems site: CORS, returned to the Systems site, source_site systems, fulfilled by the FORMS flow", async () => {
    await withEngine(async ({ post, preflight, webhook, stripe, varFile }) => {
      const pre = await preflight("/api/checkout", SYSTEMS);
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), SYSTEMS);
      const r = await post("/api/checkout", formsCart, fromSystems);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("access-control-allow-origin"), SYSTEMS);
      assert.match((await r.json()).url, /^https:\/\/checkout\.stripe\.com\//);
      const p = stripe.calls.sessions[0];
      assert.equal(p.success_url, `${SYSTEMS}/order/success/`);
      assert.equal(p.cancel_url, `${SYSTEMS}/order/cancelled/`);
      assert.equal(p.metadata.source_site, "systems");
      assert.equal(p.metadata.return_origin, SYSTEMS);
      assert.equal(p.line_items[0].price_data.unit_amount, 219900, "re-priced from the catalogue");
      assert.deepEqual(p.line_items[0].price_data.product_data.metadata, { packageId: "builder:domestic" });
      const s = [...stripe.sessions.values()][0];
      const w = await webhook(completed(s));
      assert.equal(w.status, 200);
      const orders = await varFile("orders.jsonl");
      assert.equal(orders.length, 1);
      assert.equal(orders[0].items[0].packageId, "builder:domestic");
      assert.equal(orders[0].sourceSite, "systems");
    });
  });

  test("every existing rule still holds for the storefront itself (same-origin, no returnOrigin)", async () => {
    await withEngine(async ({ post, stripe }) => {
      const r = await post("/api/checkout", { cart: [{ packageId: "builder:domestic" }], acceptedTerms: true });
      assert.equal(r.status, 200);
      assert.equal(stripe.calls.sessions[0].success_url, `${FORMS}/order/success/`);
      assert.equal(stripe.calls.sessions[0].metadata.source_site, "forms");
      assert.equal((await post("/api/checkout", { cart: [{ packageId: "builder:domestic" }] })).status, 400, "terms still required");
      assert.equal((await post("/api/checkout", { cart: [{ packageId: "nope" }], acceptedTerms: true })).status, 404);
    });
  });

  test("a non-allowlisted origin is refused on every checkout route; returnOrigin must be allowlisted and the caller's own", async () => {
    await withEngine(async ({ post, preflight, stripe }) => {
      for (const route of ["/api/checkout", "/api/founding/checkout", "/api/subscribe"]) {
        const pre = await preflight(route, EVIL);
        assert.equal(pre.status, 403, route);
        assert.equal(pre.headers.get("access-control-allow-origin"), null, route);
      }
      assert.equal((await post("/api/checkout", { ...formsCart, returnOrigin: undefined, source_site: undefined }, { Origin: EVIL })).status, 403);
      assert.equal((await post("/api/checkout", { ...formsCart, returnOrigin: EVIL, source_site: undefined })).status, 400);
      assert.equal((await post("/api/checkout", { ...formsCart, returnOrigin: FORMS, source_site: "forms" }, fromSystems)).status, 400, "a site can't send buyers to the other site");
      assert.equal((await post("/api/checkout", { ...formsCart, source_site: "forms" }, fromSystems)).status, 400, "source_site must match");
      assert.equal((await post("/api/founding/checkout", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: TERMS }, { Origin: EVIL })).status, 403);
      assert.equal(stripe.calls.sessions.length, 0);
    });
  });
});

describe("WP-S10: founding and app subscriptions through P2's routes", () => {
  test("a founding purchase from the Systems site: returned there, source_site recorded, sale recorded by the webhook", async () => {
    await withEngine(async ({ post, webhook, stripe, varFile, dir }) => {
      const r = await post("/api/founding/checkout", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: TERMS, returnOrigin: SYSTEMS }, fromSystems);
      assert.equal(r.status, 200);
      const p = stripe.calls.sessions[0];
      assert.equal(p.metadata.kind, "founding");
      assert.equal(p.metadata.source_site, "systems");
      assert.equal(p.success_url, `${SYSTEMS}/founding/success/?session_id={CHECKOUT_SESSION_ID}`);
      assert.equal(p.cancel_url, `${SYSTEMS}/founding/cancelled/?session_id={CHECKOUT_SESSION_ID}`);
      const s = [...stripe.sessions.values()][0];
      const w = await webhook(completed(s, { amount_total: 1021020, amount_subtotal: 928200, total_details: { amount_tax: 92820 } }));
      assert.equal(w.status, 200);
      assert.equal((await w.json()).founding_sale_id, "FND-0001");
      const ledger = JSON.parse(await readFile(path.join(dir, "var/founding/ledger.json"), "utf8"));
      assert.equal(ledger.sales.length, 1);
      assert.equal((await varFile("orders.jsonl")).length, 0, "not sent down the FORMS one-off flow");
    });
  });

  test("the 21st founding place is refused", async () => {
    await withEngine(async ({ post }) => {
      for (let i = 0; i < 20; i++) {
        const r = await post("/api/founding/checkout", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: TERMS }, { ...fromSystems, "X-Forwarded-For": `203.0.113.${i + 1}` });
        assert.equal(r.status, 200, `place ${i + 1}`);
      }
      const r = await post("/api/founding/checkout", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: TERMS }, { ...fromSystems, "X-Forwarded-For": "203.0.113.99" });
      assert.equal(r.status, 409);
      assert.match((await r.json()).reason, /founding place/i);
    });
  });

  test("founding and app sales never start on (or return to) the storefront itself: it has no /founding/* or /app/* pages", async () => {
    await withEngine(async ({ post }) => {
      const r = await post("/api/founding/checkout", { productId: "app:audit:seat", acceptedTerms: true, termsVersion: TERMS });
      assert.equal(r.status, 409);
      const j = await r.json();
      assert.equal(j.code, "sold_on_systems_site");
      assert.match(j.url, /^https:\/\/www\.siteguardsystems\.com\.au\//);
    });
    await withEngine(async ({ post, stripe }) => {
      const r = await post("/api/subscribe", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: SUB_TERMS, returnOrigin: FORMS, source_site: "forms" });
      assert.equal(r.status, 409);
      assert.equal((await r.json()).code, "sold_on_systems_site");
      assert.equal(stripe.calls.sessions.length, 0);
    }, { appStatus: "live", launch: { live: true }, config: { app_subscriptions_open: true }, now: new Date("2027-06-02T00:00:00Z") });
  });

  test("decision #90: a Stripe price whose recorded amount isn't the price list's is never sold (re-run sync-app-stripe)", async () => {
    await withEngine(async ({ post, stripe, dir }) => {
      const stale = structuredClone(MAP);
      stale.byProductId["app:trade:domestic"].amounts_cents_ex_gst = { annual: 235200, monthly: 21168 }; // the old to-the-cent figure
      await writeFile(path.join(dir, "map.json"), JSON.stringify(stale));
      const body = { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: SUB_TERMS, returnOrigin: SYSTEMS };
      assert.equal((await post("/api/subscribe", { ...body, cadence: "monthly" }, fromSystems)).status, 503);
      assert.equal(stripe.calls.sessions.length, 0);
      assert.equal((await post("/api/subscribe", { ...body, cadence: "annual" }, fromSystems)).status, 200, "a matching amount still sells");
    }, { appStatus: "live", launch: { live: true }, config: { app_subscriptions_open: true }, now: new Date("2027-06-02T00:00:00Z") });
  });

  test("founding sells only while app_status is presale (and P2's window is open)", async () => {
    for (const appStatus of ["coming_soon", "live"]) {
      await withEngine(async ({ post }) => {
        const r = await post("/api/founding/checkout", { productId: "app:audit:seat", acceptedTerms: true, termsVersion: TERMS, returnOrigin: SYSTEMS });
        assert.equal(r.status, 409, appStatus);
        assert.equal((await r.json()).code, "FOUNDING_NOT_OPEN");
      }, { appStatus, launch: { live: true } });
    }
    await withEngine(async ({ post }) => {
      const r = await post("/api/founding/checkout", { productId: "app:audit:seat", acceptedTerms: true, termsVersion: TERMS, returnOrigin: SYSTEMS });
      assert.equal(r.status, 409, "presale, but before P2's sale_opens_at");
      assert.match((await r.json()).reason, /open on 2027-03-01/);
    }, { now: new Date("2027-02-01T00:00:00Z") });
  });

  test("an app annual subscription: app_status live, the platform says appGoLive, P2's date passed and its switch on", async () => {
    const open = { appStatus: "live", launch: { live: true }, config: { app_subscriptions_open: true }, now: new Date("2027-06-02T00:00:00Z") };
    await withEngine(async ({ post, webhook, stripe, varFile, dir }) => {
      const r = await post("/api/subscribe", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: SUB_TERMS, returnOrigin: SYSTEMS }, fromSystems);
      assert.equal(r.status, 200);
      const p = stripe.calls.sessions[0];
      assert.equal(p.mode, "subscription");
      assert.deepEqual(p.line_items, [{ price: "price_app:trade:domestic_annual", quantity: 1 }], "annual by default");
      assert.equal(p.metadata.source_site, "systems");
      assert.equal(p.success_url, `${SYSTEMS}/app/success/`);
      const w = await webhook(completed([...stripe.sessions.values()][0]));
      assert.equal(w.status, 200);
      const subs = await varFile("app-subscriptions.jsonl");
      assert.equal(subs.length, 1);
      assert.equal(subs[0].for_dan, true);
      assert.equal(subs[0].source_site, "systems");
      assert.equal((await varFile("mail-events.jsonl")).filter((m) => !m.stub).length, 0, "no email sent");
    }, open);
    // Each gate alone keeps it closed.
    for (const [why, over] of [["app_status presale", { appStatus: "presale" }], ["platform not live", { launch: { live: false, reason: "x" } }],
      ["P2 switch off", { config: { app_subscriptions_open: false } }], ["before P2's go-live date", { now: new Date("2027-05-30T00:00:00Z") }]]) {
      await withEngine(async ({ post }) => {
        const r = await post("/api/subscribe", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: SUB_TERMS, returnOrigin: SYSTEMS });
        assert.equal(r.status, 409, why);
        assert.equal((await r.json()).code, "APP_NOT_OPEN", why);
      }, { ...open, ...over });
    }
  });
});

describe("gates, launch check and routing (units)", () => {
  test("appGates lists every disagreement between app_status, P2's config and the platform", () => {
    const cfg = { ...structuredClone(CONFIG), app_subscriptions_open: false };
    cfg.founding.sale_opens_at = "2027-03-01";
    const g = appGates(cfg, "presale", new Date("2027-02-01T00:00:00Z"), { live: false });
    assert.equal(g.founding.open, true, "the ledger then applies P2's window");
    assert.match(g.disagreements.join("\n"), /presale.*founding window is closed/);
    const live = appGates(cfg, "live", new Date("2027-06-02T00:00:00Z"), { live: false, reason: "launch endpoint answered 503" });
    assert.equal(live.subscriptions.open, false);
    assert.match(live.disagreements.join("\n"), /app subscriptions closed/);
    assert.match(live.disagreements.join("\n"), /launch endpoint doesn't say appGoLive/);
    const ok = appGates({ ...cfg, app_subscriptions_open: true }, "live", new Date("2027-06-02T00:00:00Z"), { live: true });
    assert.equal(ok.subscriptions.open, true);
    assert.deepEqual(ok.disagreements, []);
  });

  test("launch check: live only on 200 with appGoLive true within 5 s; cached at most 5 minutes", async () => {
    let calls = 0, t = 0;
    const answer = { status: 200, body: { appGoLive: true, goLiveDate: "2027-06-01", plannedGoLiveDate: "2027-06-01", pricingRevision: "Rev06" } };
    const fetchImpl = async () => { calls += 1; return { status: answer.status, json: async () => answer.body }; };
    const check = makeLaunchCheck({ url: "https://audit.test/api/platform/launch", fetchImpl, nowMs: () => t });
    assert.equal((await check()).live, true);
    answer.body = { appGoLive: false };
    t = 4 * 60_000;
    assert.equal((await check()).live, true, "cached");
    t = 5 * 60_000 + 1;
    assert.equal((await check()).live, false, "re-read after 5 minutes");
    assert.equal(calls, 2);
    const bad = makeLaunchCheck({ url: "u", fetchImpl: async () => ({ status: 500, json: async () => ({ appGoLive: true }) }) });
    assert.equal((await bad()).live, false);
    const slow = makeLaunchCheck({ url: "u", timeoutMs: 20, fetchImpl: (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
    assert.match((await slow()).reason, /timeout/);
    assert.equal((await makeLaunchCheck({})()).live, false, "no URL: not live");
  });

  test("classifySession routes by session and line metadata", () => {
    const line = (md) => ({ price: { product: { metadata: md } } });
    assert.equal(classifySession({ metadata: {} }, [line({ packageId: "builder:domestic" }), line({ documentCode: "SAF-FRM-GEN-001" })]), "forms");
    assert.equal(classifySession({ metadata: { kind: "founding" } }, []), "founding");
    assert.equal(classifySession({ metadata: { kind: "app_subscription" } }, [line({ app_product_id: "app:audit:seat", cadence: "annual" })]), "app_subscription");
    assert.equal(classifySession({ metadata: {} }, [line({ appPlan: "app:audit:seat" })]), "app_subscription");
    assert.equal(classifySession({ metadata: {} }, [line({ app_product_id: "app:audit:seat", cadence: "founding" })]), "founding");
    assert.equal(classifySession({ metadata: {} }, [line({ packageId: "x" }), line({ appPlan: "app:audit:seat" })]), "mixed");
    assert.equal(classifySession({ metadata: { kind: "founding" } }, [line({ packageId: "x" })]), "mixed");
  });

  test("a mixed session is recorded for review, not fulfilled", async () => {
    await withEngine(async ({ webhook, varFile }) => {
      const ev = { id: "evt_mixed", type: "checkout.session.completed", data: { object: { id: "cs_test_mixed", payment_status: "paid", metadata: { kind: "founding" },
        line_items: { data: [{ price: { product: { metadata: { packageId: "builder:domestic" } } } }] } } } };
      const r = await webhook(ev);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).review, true);
      assert.equal((await varFile("orders-needing-review.jsonl")).length, 1);
    });
  });

  test("a webhook with a bad signature is refused", async () => {
    await withEngine(async ({ base }) => {
      const r = await fetch(base + "/api/webhook/stripe", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=bad" }, body: "{}" });
      assert.equal(r.status, 400);
    });
  });

  test("origin policy", () => {
    const o = makeOriginPolicy({ publicOrigin: FORMS, systemsOrigins: [SYSTEMS, "https://siteguardsystems.com.au"] });
    assert.equal(o.siteOf(SYSTEMS), "systems");
    assert.equal(o.siteOf(FORMS), "forms");
    assert.equal(o.siteOf(EVIL), null);
    assert.deepEqual(o.resolveReturn({ headers: {} }, {}), { origin: FORMS, site: "forms" });
    assert.deepEqual(o.resolveReturn({ headers: { origin: SYSTEMS } }, {}), { origin: SYSTEMS, site: "systems" });
  });
});
