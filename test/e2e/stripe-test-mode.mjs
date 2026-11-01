#!/usr/bin/env node
// End-to-end run against Stripe TEST MODE (rollout P2). Real Stripe objects,
// real hosted Checkout pages paid with Stripe's 4242 test card in headless
// Chromium, real Stripe Tax, real refunds and a Stripe test clock. The only
// stand-ins: the webhook (Stripe's real event JSON for each session is fetched
// from the API and re-signed with a local secret, because Stripe can't reach
// this machine), the FORMS order intake (a local fake that records the call)
// and email (never sent).
//
// Refuses to run with anything but a TEST key.
//   STRIPE_SECRET_KEY=sk_test_... FORMS_STRIPE_MAP=<SiteGuard-Forms>/app/server/data/pack-catalog-stripe.test.json \
//     node test/e2e/stripe-test-mode.mjs
import Stripe from "stripe";
import { mkdtemp, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { createApp } from "../../lib/create-app.js";
import { payHostedCheckout } from "./stripe-checkout-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(key)) { console.error("Refusing: STRIPE_SECRET_KEY must be a Stripe TEST key."); process.exit(3); }
const stripe = new Stripe(key);
const { chromium } = await import("playwright");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}
async function step(name, fn) {
  try { record(name, true, (await fn()) ?? {}); } catch (err) { record(name, false, { error: err.message }); }
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
const dir = await mkdtemp(path.join(tmpdir(), "sg-p2-e2e-"));
const catalogue = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
catalogue.preview = false;
const catalogPath = path.join(dir, "catalogue.json");
await writeFile(catalogPath, JSON.stringify(catalogue));
const baseConfig = JSON.parse(await readFile(path.join(ROOT, "data/app-billing.json"), "utf8"));
const configPath = path.join(dir, "app-billing.json");
async function setConfig(c) {
  await writeFile(configPath, JSON.stringify(c));
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6) + 1000);
  await utimes(configPath, t, t);
}
const mapPath = path.join(ROOT, "data/app-billing-stripe.test.json");
const appMap = JSON.parse(await readFile(mapPath, "utf8"));
const webhookSecret = `whsec_${randomBytes(16).toString("hex")}`;
const adminToken = randomBytes(24).toString("hex");
const intake = [];

let port;
const app = createApp({
  catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
  stripeWebhookSecret: webhookSecret, stripeAutomaticTax: true, publicOrigin: "https://example.com",
  mailer: { configured: false }, leadAllowedOrigins: [],
  orderIntakeUrl: "http://intake.invalid/api/v3/storefront-orders", orderIntakeApiKey: "e2e",
  fetchImpl: async (_u, init) => { intake.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({ id: `order_${intake.length}` }) }; },
  appBillingPath: configPath, appBillingStripePath: mapPath, foundingAdminToken: adminToken, trustProxy: true,
});
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
port = server.address().port;
const base = `http://127.0.0.1:${port}`;
// success/cancel URLs only need to be a page the browser can land on (Stripe cannot redirect to this machine)
const SUCCESS = "https://example.com/";
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const getJson = async (p, headers = {}) => (await fetch(base + p, { headers })).json();
const admin = { Authorization: `Bearer ${adminToken}` };
let ip = 1;
const nextIp = () => ({ "X-Forwarded-For": `198.51.100.${ip++}` });

/** Fetches Stripe's real checkout.session.completed event for a session and delivers it, re-signed. */
async function deliverCompleted(sessionId) {
  for (let i = 0; i < 30; i++) {
    const evs = await stripe.events.list({ type: "checkout.session.completed", limit: 20 });
    const ev = evs.data.find((e) => e.data.object.id === sessionId);
    if (ev) {
      const payload = JSON.stringify(ev);
      const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
      const r = await fetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": sig }, body: payload });
      return { status: r.status, body: await r.json().catch(() => null), eventId: ev.id };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`no checkout.session.completed event for ${sessionId}`);
}
async function deliver(ev) {
  const payload = JSON.stringify(ev);
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  return fetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": sig }, body: payload });
}

const browser = await chromium.launch();
const shots = path.join(dir, "shots");
const cents = (aud) => Math.round(aud * 100);
try {
  // ---- 1. FORMS one-off (storefront /api/checkout) ----
  await step("FORMS one-off (storefront checkout, hosted page, webhook, intake)", async () => {
    const pack = catalogue.packs.find((p) => p.listed && p.sellable && p.prices?.one_off && p.purchasable !== false);
    const r = await (await post("/api/checkout", { cart: [{ packageId: pack.id }], acceptedTerms: true, termsVersion: "e2e" }, nextIp())).json();
    assert.ok(r.ok, JSON.stringify(r));
    const sessionId = new URL(r.url).pathname.split("/").pop().split("#")[0];
    // success_url in the session points at publicOrigin; wait for any 127.0.0.1 landing
    await payHostedCheckout(browser, r.url, { customFields: { client_name: "E2E One-off Pty Ltd", project_address: "1 Test St, Sydney NSW 2000" }, successUrlPrefix: SUCCESS, screenshotPath: path.join(dir, "oneoff.png") });
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    assert.equal(s.payment_status, "paid");
    assert.equal(s.amount_subtotal, cents(pack.prices.one_off));
    assert.equal(s.total_details.amount_tax, Math.round(cents(pack.prices.one_off) * 0.1));
    const d = await deliverCompleted(s.id);
    assert.equal(d.status, 200);
    assert.ok(intake.some((o) => o.packageId === pack.id && o.stripeSessionId.startsWith(s.id)));
    return { pack: pack.id, catalogue_pricing_revision: catalogue.pricing_revision, ex_gst: s.amount_subtotal / 100, gst: s.total_details.amount_tax / 100, total: s.amount_total / 100, session: s.id };
  });

  // ---- 2. FORMS annual (the FORMS app's subscription checkout, same session params, Rev06 test price) ----
  await step("FORMS annual subscription (FORMS app checkout params, Rev06 test price)", async () => {
    const mapFile = process.env.FORMS_STRIPE_MAP;
    if (!mapFile) throw new Error("FORMS_STRIPE_MAP not set");
    const formsMap = JSON.parse(await readFile(mapFile, "utf8"));
    const entry = formsMap.byPackId["builder:domestic"];
    const customer = await stripe.customers.create({ email: "delivered@resend.dev", name: "E2E FORMS Annual", metadata: { e2e: "p2" } });
    const s = await stripe.checkout.sessions.create({
      mode: "subscription", customer: customer.id, line_items: [{ price: entry.annualPriceId, quantity: 1 }],
      automatic_tax: { enabled: true }, billing_address_collection: "required", customer_update: { address: "auto", name: "auto" },
      tax_id_collection: { enabled: true }, success_url: `${SUCCESS}?forms`, cancel_url: `${SUCCESS}?cancel`,
    });
    await payHostedCheckout(browser, s.url, { successUrlPrefix: SUCCESS });
    const done = await stripe.checkout.sessions.retrieve(s.id, { expand: ["subscription.latest_invoice"] });
    assert.equal(done.status, "complete");
    const inv = done.subscription.latest_invoice;
    assert.equal(inv.subtotal, entry.subscriptionAudPerYear * 100);
    assert.equal(inv.tax ?? inv.total_taxes?.reduce((t, x) => t + x.amount, 0), Math.round(entry.subscriptionAudPerYear * 10));
    return { pack: "builder:domestic", annual_ex_gst: inv.subtotal / 100, gst: (inv.total - inv.subtotal) / 100, total: inv.total / 100, subscription: done.subscription.id, status: done.subscription.status, interval: done.subscription.items.data[0].price.recurring.interval };
  });

  // ---- 3. App annual (/api/subscribe, app open) ----
  await step("App annual subscription (/api/subscribe, trade package Domestic, annual default)", async () => {
    await setConfig({ ...baseConfig, app_go_live_date: today, app_subscriptions_open: true });
    const closed = { ...baseConfig };
    const r = await (await post("/api/subscribe", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: baseConfig.checkout_notice.terms_version }, nextIp())).json();
    assert.ok(r.ok, JSON.stringify(r));
    await payHostedCheckout(browser, r.url, { customFields: { client_name: "E2E App Annual" }, successUrlPrefix: SUCCESS });
    const done = await stripe.checkout.sessions.retrieve(r.session_id, { expand: ["subscription.latest_invoice"] });
    const d = await deliverCompleted(r.session_id);
    assert.equal(d.status, 200);
    const sub = done.subscription;
    assert.equal(sub.items.data[0].price.id, appMap.byProductId["app:trade:domestic"].prices.annual);
    assert.equal(sub.latest_invoice.subtotal, 235200);
    await setConfig(closed);
    const refused = await post("/api/subscribe", { productId: "app:trade:domestic", trade: "CARP", acceptedTerms: true, termsVersion: baseConfig.checkout_notice.terms_version }, nextIp());
    assert.equal(refused.status, 409);
    return { annual_ex_gst: 2352, invoice_total: sub.latest_invoice.total / 100, gst: (sub.latest_invoice.total - sub.latest_invoice.subtotal) / 100, interval: sub.items.data[0].price.recurring.interval, subscription: sub.id, refused_before_go_live: 409 };
  });

  // ---- 4. Founding purchase ----
  // The sale window opens 1 Mar 2027; for this run it is opened "today" in a temp config.
  const foundingCfg = { ...baseConfig, founding: { ...baseConfig.founding, sale_opens_at: today } };
  await setConfig(foundingCfg);
  let sale;
  await step("Founding purchase (builder bundle Domestic): reserve, pay, record, renewal subscription, FORMS grant", async () => {
    const before = await getJson("/api/founding/places");
    const r = await (await post("/api/founding/checkout", { productId: "app:builder:domestic", acceptedTerms: true, termsVersion: baseConfig.checkout_notice.terms_version }, nextIp())).json();
    assert.ok(r.ok, JSON.stringify(r));
    await payHostedCheckout(browser, r.url, { customFields: { client_name: "E2E Founding Builders Pty Ltd", project_address: "2 Test St, Sydney NSW 2000" }, successUrlPrefix: SUCCESS, screenshotPath: path.join(dir, "founding.png") });
    const d = await deliverCompleted(r.session_id);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    sale = (await getJson("/api/founding/admin/sales", admin)).sales[0];
    const sub = await stripe.subscriptions.retrieve(sale.stripe_subscription_id);
    assert.equal(sale.price_paid_cents_ex_gst, 928200);
    assert.equal(sale.gst_cents, 92820);
    assert.equal(sale.expected_start_date, "2027-06-01");
    assert.equal(sale.service_end_date, "2028-06-01");
    assert.equal(sub.status, "trialing");
    assert.equal(sub.items.data[0].price.unit_amount, 1092000, "renews at the standard annual price");
    const g = intake.find((o) => o.option === "founding-grant");
    assert.equal(g.packageId, "builder:domestic");
    const after = await getJson("/api/founding/places");
    return {
      places_before: before.remaining, places_after: after.remaining, sale_id: sale.sale_id, paid_ex_gst: 9282, gst: sale.gst_cents / 100, total: sale.amount_paid_total_cents / 100,
      expected_start: sale.expected_start_date, service_end: sale.service_end_date, terms_version: sale.terms_version,
      renewal_subscription: sub.id, renewal_trial_end: new Date(sub.trial_end * 1000).toISOString(), forms_grant: g.packageId,
    };
  });

  // ---- 5. Two-month delay: credits applied automatically ----
  await step("Go-live moves 2 months (1 Jun -> 1 Aug 2027): 2 free months credited, Stripe renewal moved", async () => {
    await setConfig({ ...foundingCfg, app_go_live_date: "2027-08-01" });
    const s = (await getJson("/api/founding/admin/sales", admin)).sales[0];
    const sub = await stripe.subscriptions.retrieve(s.stripe_subscription_id);
    assert.deepEqual(s.delay_credits.map((c) => c.months), [2]);
    assert.equal(s.expected_start_date, "2027-08-01");
    assert.equal(s.service_end_date, "2028-10-01");
    assert.equal(new Date(sub.trial_end * 1000 + 10 * 3_600_000).toISOString().slice(0, 10), "2028-10-01");
    return { credit_months: 2, expected_start: s.expected_start_date, service_end: s.service_end_date, stripe_trial_end: new Date(sub.trial_end * 1000).toISOString() };
  });

  // ---- 5b. The same on a Stripe test clock: time actually runs ----
  await step("Test clock: founding renewal survives the original end date, renews at standard price after the credited end", async () => {
    const t0 = Math.floor(new Date("2027-03-10T00:00:00Z").getTime() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: "P2 founding delay" });
    const cust = await stripe.customers.create({ test_clock: clock.id, email: "delivered@resend.dev", payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" }, address: { country: "AU", line1: "1 Test St", city: "Sydney", state: "NSW", postal_code: "2000" } });
    const aest = (d) => Math.floor((Date.parse(`${d}T00:00:00Z`) - 10 * 3_600_000) / 1000);
    const sub = await stripe.subscriptions.create({ customer: cust.id, items: [{ price: appMap.byProductId["app:builder:domestic"].prices.annual }], trial_end: aest("2028-06-01"), automatic_tax: { enabled: true }, proration_behavior: "none", metadata: { kind: "founding_renewal", e2e: "test-clock" } });
    // the delay credit, exactly as the storefront applies it
    await stripe.subscriptions.update(sub.id, { trial_end: aest("2028-10-01"), proration_behavior: "none" });
    const advance = async (iso) => {
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: Math.floor(Date.parse(iso) / 1000) });
      for (let i = 0; i < 60; i++) { const c = await stripe.testHelpers.testClocks.retrieve(clock.id); if (c.status === "ready") return; await new Promise((r) => setTimeout(r, 2000)); }
      throw new Error("test clock did not settle");
    };
    await advance("2028-07-01T00:00:00Z");
    const mid = await stripe.subscriptions.retrieve(sub.id);
    await advance("2028-10-05T00:00:00Z");
    const end = await stripe.subscriptions.retrieve(sub.id, { expand: ["latest_invoice"] });
    assert.equal(mid.status, "trialing");
    assert.equal(end.status, "active");
    assert.equal(end.latest_invoice.subtotal, 1092000);
    await stripe.testHelpers.testClocks.del(clock.id);
    return { status_after_original_end: mid.status, status_after_credited_end: end.status, renewal_invoice_ex_gst: end.latest_invoice.subtotal / 100, renewal_invoice_total: end.latest_invoice.total / 100 };
  });

  // ---- 6. 21st founding purchase refused (real sessions), then released ----
  await step("Stock: 19 more reservations fill the 20; the 21st is refused; cancelling releases them", async () => {
    const sessions = [];
    const reqs = await Promise.all(Array.from({ length: 20 }, () => post("/api/founding/checkout", { productId: "app:audit:seat", quantity: 2, acceptedTerms: true, termsVersion: baseConfig.checkout_notice.terms_version }, nextIp())));
    const bodies = await Promise.all(reqs.map((r) => r.json()));
    for (const b of bodies) if (b.ok) sessions.push(b.session_id);
    const refused = bodies.filter((b) => !b.ok);
    const full = await getJson("/api/founding/places");
    for (const id of sessions) await post("/api/founding/checkout/cancel", { session_id: id }, nextIp());
    const after = await getJson("/api/founding/places");
    assert.equal(sessions.length, 19);
    assert.equal(refused.length, 1);
    assert.equal(full.remaining, 0);
    assert.equal(after.remaining, 19);
    return { reserved: sessions.length, refused: refused.length, refused_reason: refused[0]?.reason, remaining_when_full: full.remaining, remaining_after_cancel: after.remaining };
  });

  // ---- 7. Refund of the unused prepayment ----
  await step("Refund of the unused prepayment (on request, before go-live: all of it)", async () => {
    const r = await (await post("/api/founding/admin/refund", { sale_id: sale.sale_id, reason: "e2e: customer request after delay" }, admin)).json();
    assert.ok(r.ok, JSON.stringify(r));
    const refund = await stripe.refunds.retrieve(r.refund.id);
    const sub = await stripe.subscriptions.retrieve(sale.stripe_subscription_id);
    assert.equal(refund.amount, sale.amount_paid_total_cents);
    assert.equal(sub.status, "canceled");
    const feed = await getJson("/api/founding/feed");
    return { refund: refund.id, amount: refund.amount / 100, stripe_status: refund.status, renewal: sub.status, sale_status: r.sale.status, feed: feed.figures };
  });

  // ---- 8. Webhook signature still enforced; gated products absent ----
  await step("No gated product is active in the Stripe test account", async () => {
    const GATED = /\b(siteguard\s+core|core\s+(module|project|suite|platform)|siteguard\s+ai|ai\s+role|robot|robotics|new\s+zealand|nz|singapore|overseas)\b/i;
    const hits = [];
    for await (const p of stripe.products.list({ active: true, limit: 100 })) if (GATED.test(`${p.name} ${p.description ?? ""} ${JSON.stringify(p.metadata)}`)) hits.push(p.name);
    assert.deepEqual(hits, []);
    const bad = await fetch(`${base}/api/webhook/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=bad" }, body: "{}" });
    assert.equal(bad.status, 400);
    return { gated_products: 0, bad_signature: bad.status };
  });
} finally {
  await browser.close();
  server.close();
  const out = path.join(dir, "e2e-report.json");
  await writeFile(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed. Report: ${out}`);
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
