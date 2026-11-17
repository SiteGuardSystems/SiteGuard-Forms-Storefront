// FORMS queue S13: the whole one-off checkout, with the FORMS switches faked
// open and Stripe faked. The session carries the acceptance, the terms version
// and the utm values; prices come from the catalogue, never the browser; a
// subscription, consultant plan or app line is refused server-side even when
// the browser sends one; S1 off, switches unreadable or beta refuse before
// Stripe is called.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp } from "../lib/create-app.js";
import { createCampaignCounter } from "../lib/site-metrics.js";

const ALL_OPEN = { sales_open: true, delivery_mode: "manual", delivery_sla_business_days: 3, subscriptions_open: true, consultant_plans_open: true, read_ok: true };
const PACK = "subcontractor:CARP:domestic";

async function withShop({ switches = async () => ALL_OPEN, beta = false, ...opts } = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-whole-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify({
    schema: 1, preview: false, currency: "AUD", generated_at: "2026-11-16T00:00:00+00:00",
    packs: [
      { id: PACK, group: "trade-packs", name: "Carpentry Pack: Domestic", listed: true, sellable: true, show: true, purchasable: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { one_off: 599, annual: 1049, monthly: 100 } },
      { id: "consultant:t1", group: "consultants", name: "Consultant T1", listed: true, sellable: true, show: true, subscription_only: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { annual: 7999, monthly: 765 } },
      { id: "builder:sub-only", group: "builder-packs", name: "Builder subscription pack", listed: true, sellable: true, show: true, subscription_only: true,
        count: 1, documents: ["SAF-SWMS-CARP-001"], prices: { annual: 4999, monthly: 480 } },
    ],
    documents: [{ code: "SAF-SWMS-CARP-001", title: "General Carpentry Works", family: "SWMS", price: 49, sellable: true }],
  }));
  const calls = [];
  const stripe = { checkout: { sessions: { create: async (p) => { calls.push(p); return { id: "cs_test_whole", url: "https://stripe.test/c" }; } } } };
  const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
    publicOrigin: "http://localhost:4300", mailer: { configured: false }, leadAllowedOrigins: [], switches, beta,
    campaignCounter: createCampaignCounter({ file: path.join(dir, "var", "campaigns.json") }), ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, calls });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}
const checkout = (base, body) => fetch(`${base}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const GOOD = { cart: [{ packageId: PACK }, { documentCode: "SAF-SWMS-CARP-001" }], acceptedTerms: true, termsVersion: "tos-v0.5+dud-v3",
  siteName: "Riverside Apartments", utm_source: "linkedin", utm_medium: "social", utm_campaign: "carpentry-nov" };

describe("the whole one-off checkout (S13)", () => {
  test("switches open: one Stripe session with the acceptance, terms version, utm values and catalogue prices", async () => {
    await withShop({}, async ({ base, calls }) => {
      const r = await checkout(base, { ...GOOD, cart: [{ packageId: PACK, price: 1 }, { documentCode: "SAF-SWMS-CARP-001", price: 1 }] });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).url, "https://stripe.test/c");
      assert.equal(calls.length, 1);
      const s = calls[0];
      assert.equal(s.mode, "payment", "one-off only");
      assert.equal(s.metadata.accepted, "terms-of-sale,document-use-disclaimer");
      assert.equal(s.metadata.termsVersion, "tos-v0.5+dud-v3");
      assert.equal(s.metadata.siteName, "Riverside Apartments");
      assert.equal(s.metadata.utm_source, "linkedin");
      assert.equal(s.metadata.utm_campaign, "carpentry-nov");
      assert.deepEqual(s.line_items.map((l) => l.price_data.unit_amount), [59900, 4900], "prices from the catalogue, not the browser");
      assert.ok(s.line_items.every((l) => l.price_data.tax_behavior === "exclusive" && l.price_data.currency === "aud"));
    });
  });

  test("terms not accepted: refused, Stripe never called", async () => {
    await withShop({}, async ({ base, calls }) => {
      const r = await checkout(base, { ...GOOD, acceptedTerms: undefined });
      assert.equal(r.status, 400);
      assert.match((await r.json()).reason, /Document Use Disclaimer/);
      assert.equal(calls.length, 0);
    });
  });

  test("a subscription, consultant plan or app line is refused server-side even with every switch open", async () => {
    await withShop({}, async ({ base, calls }) => {
      for (const [cart, status] of [
        [[{ packageId: "consultant:t1" }], 409],
        [[{ packageId: "builder:sub-only" }], 409],
        [[{ packageId: PACK }, { packageId: "builder:sub-only" }], 409],
        [[{ packageId: "app:audit:annual" }], 400],
        [[{ packageId: "founding:place" }], 400],
        [[{ packageId: PACK, kind: "app_subscription" }], 400],
      ]) {
        const r = await checkout(base, { ...GOOD, cart });
        assert.equal(r.status, status, JSON.stringify(cart));
      }
      assert.equal(calls.length, 0, "no Stripe session for any of them");
    });
  });

  test("S1 off, switches unreadable or the beta switch on: refused before Stripe", async () => {
    for (const opts of [
      { switches: async () => ({ ...ALL_OPEN, sales_open: false }) },
      { switches: async () => { throw new Error("FORMS unreachable"); } },
      { switches: async () => null },
      { beta: true },
    ]) {
      await withShop(opts, async ({ base, calls }) => {
        const r = await checkout(base, GOOD);
        assert.equal(r.status, 503, JSON.stringify(Object.keys(opts)));
        assert.equal(calls.length, 0);
      });
    }
  });
});
