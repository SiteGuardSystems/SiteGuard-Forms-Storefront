// Package suite audit P6 (24 Nov 2026): a builder pack bought with one trade
// pack takes the price table's bundles.builder_plus_trade discount (15% in
// Rev09) off the pair, at checkout, server-side (lib/bundles.js). Stripe is
// faked; every pack and document here is synthetic.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/create-app.js";
import { applyBundle, bundleRule, idMatches, readBundleRule } from "../lib/bundles.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEW = path.join(ROOT, "vendor", "hseq-dev", "pricing", "forms_price_table.public.json");
const ALL_OPEN = { sales_open: true, delivery_mode: "manual", delivery_sla_business_days: 3, subscriptions_open: true, consultant_plans_open: true, read_ok: true };
const RULE_TABLE = { bundles: { builder_plus_trade: { discount_pct: 15, builder: "builder:*", trade: "subcontractor:*:*", max_trade_packs: 1 } } };

const pack = (id, group, one_off, extra = {}) => ({ id, group, name: `Synthetic ${id}`, listed: true, sellable: true, show: true, purchasable: true,
  count: 1, documents: ["SAF-SWMS-TEST-001"], prices: { one_off, annual: Math.round(one_off * 1.2), monthly: 1 }, ...extra });
const CATALOGUE = {
  schema: 1, preview: false, currency: "AUD", generated_at: "2026-11-24T00:00:00+00:00",
  packs: [
    pack("builder:domestic", "builder-packs", 899),
    pack("builder:light-commercial", "builder-packs", 1699),
    pack("subcontractor:CARP:domestic", "trade-packs", 599),
    pack("subcontractor:ELEC:domestic", "trade-packs", 539),
    pack("subcontractor:FACA:domestic", "specialist-packs", 539),
    pack("subcontractor-system", "management-systems", 1799),
    pack("subcontractor:ROOF:domestic", "trade-packs", 539, { listed: false, sellable: false, show: false }),
    pack("builder:sub-only", "builder-packs", 0, { subscription_only: true, prices: { annual: 4999, monthly: 480 } }),
  ],
  documents: [{ code: "SAF-SWMS-TEST-001", title: "Synthetic test document", family: "SWMS", price: 44, sellable: true }],
};

async function withShop({ view = RULE_TABLE, viewPath } = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-bundle-"));
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify(CATALOGUE));
  let formsPriceViewPath = viewPath;
  if (formsPriceViewPath === undefined && view !== undefined) {
    formsPriceViewPath = path.join(dir, "forms_price_table.public.json");
    await writeFile(formsPriceViewPath, typeof view === "string" ? view : JSON.stringify(view));
  }
  const calls = [];
  const stripe = { checkout: { sessions: { create: async (p) => { calls.push(p); return { id: "cs_test_bundle", url: "https://stripe.test/c" }; } } } };
  const app = createApp({ catalogPath, varDir: path.join(dir, "var"), publicDir: null, stripe, stripeTestMode: true,
    publicOrigin: "http://localhost:4300", mailer: { configured: false }, leadAllowedOrigins: [], switches: async () => ALL_OPEN,
    formsPriceViewPath });
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
const checkout = (base, cart, extra = {}) => fetch(`${base}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart, acceptedTerms: true, termsVersion: "test", ...extra }) });
const amounts = (s) => s.line_items.map((l) => l.price_data.unit_amount);
const bundled = (s) => s.line_items.map((l) => l.price_data.product_data.metadata.bundle ?? null);

describe("builder + trade bundle at checkout (P6)", () => {
  test("eligible pair: 15% off both the builder pack and the trade pack", async () => {
    await withShop({}, async ({ base, calls }) => {
      const r = await checkout(base, [{ packageId: "builder:domestic" }, { packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(r.status, 200);
      const s = calls[0];
      assert.equal(s.mode, "payment", "one-off only");
      assert.deepEqual(amounts(s), [76415, 50915], "899 and 599 less 15%, to the cent");
      assert.deepEqual(bundled(s), ["builder_plus_trade", "builder_plus_trade"]);
      assert.equal(s.metadata.bundle, "builder_plus_trade");
      assert.deepEqual(s.line_items.map((l) => l.price_data.product_data.metadata.list_amount), ["89900", "59900"]);
      assert.equal(s.line_items[0].price_data.product_data.name, "Synthetic builder:domestic", "the pack name is unchanged (FORMS intake)");
      assert.match(s.line_items[0].price_data.product_data.description, /Builder \+ trade bundle: 15% off/);
    });
  });

  test("cart order doesn't matter, and a specialist pack counts as a trade pack (subcontractor:*:*)", async () => {
    await withShop({}, async ({ base, calls }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:FACA:domestic" }, { packageId: "builder:domestic" }])).status, 200);
      assert.deepEqual(amounts(calls[0]), [45815, 76415]);
    });
  });

  test("two trade packs and no builder pack: no discount", async () => {
    await withShop({}, async ({ base, calls }) => {
      assert.equal((await checkout(base, [{ packageId: "subcontractor:CARP:domestic" }, { packageId: "subcontractor:ELEC:domestic" }])).status, 200);
      assert.deepEqual(amounts(calls[0]), [59900, 53900]);
      assert.deepEqual(bundled(calls[0]), [null, null]);
      assert.equal(calls[0].metadata.bundle, undefined);
    });
  });

  test("a builder pack alone, or with only documents or a management system: no discount", async () => {
    await withShop({}, async ({ base, calls }) => {
      await checkout(base, [{ packageId: "builder:domestic" }]);
      await checkout(base, [{ packageId: "builder:domestic" }, { documentCode: "SAF-SWMS-TEST-001" }, { packageId: "subcontractor-system" }]);
      assert.deepEqual(amounts(calls[0]), [89900]);
      assert.deepEqual(amounts(calls[1]), [89900, 4400, 179900]);
    });
  });

  test("builder + two trade packs: one pair only, the builder with the dearer trade pack", async () => {
    await withShop({}, async ({ base, calls }) => {
      const cart = [{ packageId: "subcontractor:ELEC:domestic" }, { packageId: "builder:domestic" }, { packageId: "subcontractor:CARP:domestic" }];
      assert.equal((await checkout(base, cart)).status, 200);
      assert.deepEqual(amounts(calls[0]), [53900, 76415, 50915], "ELEC (539) full price; CARP (599) is the pair");
    });
  });

  test("two builder packs + one trade pack: one pair only, the dearer builder pack", async () => {
    await withShop({}, async ({ base, calls }) => {
      const cart = [{ packageId: "builder:domestic" }, { packageId: "builder:light-commercial" }, { packageId: "subcontractor:CARP:domestic" }];
      assert.equal((await checkout(base, cart)).status, 200);
      assert.deepEqual(amounts(calls[0]), [89900, 144415, 50915]);
    });
  });

  test("subscription: a subscription-only builder pack with a trade pack is refused, never discounted", async () => {
    await withShop({}, async ({ base, calls }) => {
      const r = await checkout(base, [{ packageId: "builder:sub-only" }, { packageId: "subcontractor:CARP:domestic" }]);
      assert.equal(r.status, 409);
      assert.match((await r.json()).reason, /subscription only/);
      assert.equal(calls.length, 0);
    });
  });

  test("tampered client prices and bundle claims are never used: the server prices every line", async () => {
    await withShop({}, async ({ base, calls }) => {
      // A claimed discount on a cart that doesn't qualify.
      await checkout(base, [{ packageId: "subcontractor:CARP:domestic", price: 1, unit_amount: 100, discount_pct: 99, bundle: "builder_plus_trade" },
        { packageId: "subcontractor:ELEC:domestic", price: 1 }], { bundle: "builder_plus_trade", discount_pct: 99, total: 1 });
      // A bigger claimed discount on a cart that does.
      await checkout(base, [{ packageId: "builder:domestic", price: 1, discount_pct: 50 }, { packageId: "subcontractor:CARP:domestic", unit_amount: 1 }],
        { discount_pct: 50 });
      assert.deepEqual(amounts(calls[0]), [59900, 53900]);
      assert.deepEqual(amounts(calls[1]), [76415, 50915]);
    });
  });

  test("an unlisted pack is still refused, bundle or not", async () => {
    await withShop({}, async ({ base, calls }) => {
      const r = await checkout(base, [{ packageId: "builder:domestic" }, { packageId: "subcontractor:ROOF:domestic" }]);
      assert.equal(r.status, 404);
      assert.match((await r.json()).reason, /unknown package/);
      assert.equal(calls.length, 0);
    });
  });

  test("it follows the price table: no bundle, a malformed bundle, an unreadable table or no table = no discount", async () => {
    const cart = [{ packageId: "builder:domestic" }, { packageId: "subcontractor:CARP:domestic" }];
    for (const opts of [
      { view: { revision: "Rev09" } },
      { view: { bundles: {} } },
      { view: { bundles: { builder_plus_trade: { discount_pct: "15", builder: "builder:*", trade: "subcontractor:*:*" } } } },
      { view: { bundles: { builder_plus_trade: { discount_pct: 100, builder: "builder:*", trade: "subcontractor:*:*" } } } },
      { view: "{not json" },
      { viewPath: path.join(tmpdir(), "sg-bundle-no-such-file.json") },
      { viewPath: null },
    ]) {
      await withShop(opts, async ({ base, calls }) => {
        assert.equal((await checkout(base, cart)).status, 200);
        assert.deepEqual(amounts(calls[0]), [89900, 59900], JSON.stringify(opts));
      });
    }
  });

  test("a changed table changes the discount (nothing is hard-coded)", async () => {
    const view = { bundles: { builder_plus_trade: { discount_pct: 10, builder: "builder:*", trade: "subcontractor:*:*", max_trade_packs: 2 } } };
    await withShop({ view }, async ({ base, calls }) => {
      const cart = [{ packageId: "builder:domestic" }, { packageId: "subcontractor:CARP:domestic" }, { packageId: "subcontractor:ELEC:domestic" }];
      assert.equal((await checkout(base, cart)).status, 200);
      assert.deepEqual(amounts(calls[0]), [80910, 53910, 48510]);
    });
  });
});

describe("lib/bundles.js", () => {
  test("idMatches: colon parts, * is any one non-empty part", () => {
    assert.equal(idMatches("builder:*", "builder:domestic"), true);
    assert.equal(idMatches("builder:*", "builder:"), false);
    assert.equal(idMatches("builder:*", "builder:domestic:x"), false);
    assert.equal(idMatches("subcontractor:*:*", "subcontractor:CARP:domestic"), true);
    assert.equal(idMatches("subcontractor:*:*", "subcontractor-system"), false);
    assert.equal(idMatches("subcontractor:*:*", "builder:domestic"), false);
    assert.equal(idMatches("builder:*", undefined), false);
  });

  test("applyBundle leaves documents (no packageId) and a rule-less cart alone", () => {
    const lines = [{ unit_amount: 4400, description: "d", metadata: { documentCode: "X" } }];
    assert.equal(applyBundle(lines, null), lines);
    assert.deepEqual(applyBundle(lines, bundleRule(RULE_TABLE)), lines);
  });

  test("the pinned price table view (pricing.lock) carries the Rev09 rule, and server.js reads it", () => {
    assert.deepEqual(readBundleRule(VIEW), { id: "builder_plus_trade", discount_pct: 15, builder: "builder:*", trade: "subcontractor:*:*", max_trade_packs: 1 });
    const server = readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.match(server, /formsPriceViewPath: path\.join\(__dirname, "vendor", "hseq-dev", "pricing", "forms_price_table\.public\.json"\)/);
  });
});

describe("the builder packs page shows the bundle (dist/, npm test builds it first)", () => {
  const html = (rel) => readFileSync(path.join(ROOT, "dist", rel), "utf8");
  test("builder packs: the note with the table's discount; trade packs page unchanged", () => {
    const b = html("builder-packs/index.html");
    assert.match(b, /id="builder-trade-bundle"/);
    assert.match(b, /Builder \+ trade bundle: 15% off the pair\./);
    assert.match(b, /One-off purchases only/);
    assert.doesNotMatch(html("trade-packs/index.html"), /builder-trade-bundle/);
  });
});
