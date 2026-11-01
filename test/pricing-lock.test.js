// Dan's decision #90 (1 Nov 2026): ONE price source, Hseq-Dev packages.py via
// docs/pricing/. This repo pins both price tables (pricing.lock +
// vendor/hseq-dev/pricing/, like dcr.lock) and must sell at exactly their
// figures: the app prices (data/app-catalogue.json, Stripe TEST prices, the
// founding prepayment) and the FORMS prices (data/catalogue.json). Nothing here
// calculates a price. To update: docs/pricing/README.md in Hseq-Dev.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripePriceList, validateAppBilling, CADENCE_ORDER } from "../lib/app-billing.js";
import { loadAppBilling, readAppCatalogue } from "../lib/app-prices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = JSON.parse(readFileSync(path.join(ROOT, "pricing.lock"), "utf8"));
const lf = (file) => readFileSync(path.join(ROOT, file)).toString("utf8").replace(/\r\n/g, "\n");
const APP = JSON.parse(lf(LOCK.files["app_price_table.json"].vendored_at));
const FORMS = JSON.parse(lf(LOCK.files["forms_price_table.json"].vendored_at));
const ROWS = Object.fromEntries([
  ...Object.entries(APP.trade_packages).map(([k, v]) => [`app:trade:${k}`, v]),
  ...Object.entries(APP.builder_bundles).map(([k, v]) => [`app:builder:${k}`, v]),
  ["app:audit:seat", APP.audit_seat],
]);

describe("pricing.lock: the pinned Hseq-Dev price tables", () => {
  test("each pinned copy hashes to the lock (sha256 of its LF form)", () => {
    assert.equal(LOCK.repo, "SiteGuardSystems/Hseq-Dev");
    for (const [name, f] of Object.entries(LOCK.files)) {
      const got = createHash("sha256").update(lf(f.vendored_at)).digest("hex");
      assert.equal(got, f.sha256, `${f.vendored_at} is not the pinned ${name}: re-run Hseq-Dev docs/pricing/export_price_tables.py`);
    }
  });
});

describe("app prices: data/app-catalogue.json is the pinned app table", () => {
  const cat = readAppCatalogue();
  test("group \"app\" rows carry the table's figures exactly", () => {
    const packs = cat.packs.filter((p) => p.group === "app");
    assert.deepEqual(packs.map((p) => p.id).sort(), Object.keys(ROWS).sort());
    for (const p of packs) {
      const row = ROWS[p.id];
      assert.equal(p.app_prices.per_month, row.price_month, p.id);
      assert.deepEqual(p.app_prices.cadences, row.prices, p.id);
      assert.equal(p.app_prices.founding_prepay_cents, row.founding.prepay_cents, p.id);
      assert.equal(p.prices, null, "app products are never sold by the FORMS checkout");
    }
    for (const k of ["revision", "currency", "prices_exclude_gst", "billing", "multi_module_discount", "founding", "rounding"]) {
      assert.deepEqual(cat.app[k], APP[k], k);
    }
  });
});

describe("app billing sells at the table's figures, never its own", () => {
  const cfg = loadAppBilling();
  test("every cadence's period price and the founding prepayment", () => {
    for (const p of cfg.products) {
      const row = ROWS[p.id];
      assert.equal(p.monthly_aud, row.price_month, p.id);
      for (const c of CADENCE_ORDER) assert.equal(p.prices_cents[c], row.prices[c].per_period * 100, `${p.id} ${c}`);
      assert.equal(p.founding_cents, row.founding.prepay_cents, p.id);
    }
    assert.equal(cfg.founding.discount, APP.founding.discount);
    assert.equal(cfg.founding.places_total, APP.founding.places);
    assert.equal(cfg.founding.term_months, APP.founding.term_months);
  });
  test("loadings come from the table; the labels say the same", () => {
    for (const [name, c] of Object.entries(cfg.cadences)) {
      const want = name === "annual" ? 0 : APP.billing.loading[name];
      assert.equal(c.loading, want, name);
      if (want) assert.match(c.label, new RegExp(`\\+${Math.round(want * 100)}%`), name);
    }
  });
  test("whole-dollar loaded prices (the workbook's), not cents (e.g. A$212, not A$211.68)", () => {
    const dom = cfg.products.find((p) => p.id === "app:trade:domestic");
    assert.equal(dom.prices_cents.monthly, 21200);
    const blc = cfg.products.find((p) => p.id === "app:builder:light-commercial");
    assert.deepEqual(blc.loaded_per_month_aud, { annual: 1279, six_monthly: 1317, quarterly: 1343, monthly: 1381 });
  });
  test("app-billing.json carries no price, loading or founding discount", () => {
    const raw = JSON.parse(readFileSync(path.join(ROOT, "data/app-billing.json"), "utf8"));
    for (const p of raw.products) assert.ok(!("monthly_aud" in p), p.id);
    for (const c of Object.values(raw.cadences)) assert.ok(!("loading" in c));
    assert.ok(!("discount" in raw.founding));
    const withPrice = structuredClone(raw);
    withPrice.products[0].monthly_aud = 196;
    assert.throws(() => validateAppBilling(withPrice, readAppCatalogue()), /app catalogue/);
    assert.throws(() => validateAppBilling(raw, { app: null, packs: [] }), /no app catalogue/);
  });
  test("the Stripe TEST price list, offline (no key, no network)", () => {
    const list = stripePriceList(cfg);
    assert.equal(list.length, Object.keys(ROWS).length * 5);
    for (const p of list) {
      assert.equal(p.currency, "aud");
      assert.equal(p.tax_behavior, "exclusive");
      const row = ROWS[p.app_product_id];
      assert.equal(p.unit_amount, p.cadence === "founding" ? row.founding.prepay_cents : row.prices[p.cadence].per_period * 100);
      assert.ok(Number.isInteger(p.unit_amount));
    }
    const monthly = list.find((p) => p.app_product_id === "app:trade:domestic" && p.cadence === "monthly");
    assert.deepEqual(monthly, { app_product_id: "app:trade:domestic", cadence: "monthly", currency: "aud", tax_behavior: "exclusive", unit_amount: 21200, recurring: { interval: "month", interval_count: 1 } });
  });
});

describe("FORMS prices: data/catalogue.json is the pinned FORMS table", () => {
  // Every FORMS price must be one the table states: a flat or retired pack at
  // exactly its own figures, a banded pack at one of the table's band rows
  // (which band is packages.py's call; Hseq-Dev's own drift test checks it),
  // monthly by the table's billing rule.
  const exact = {};
  const pairs = new Set();
  const key = (o, a) => `${o}/${a}`;
  for (const rows of Object.values(FORMS.bands)) for (const r of rows) pairs.add(key(r.one_off, r.annual));
  for (const sec of ["flat", "not_in_workbook", "dcr_packs"]) {
    for (const [k, v] of Object.entries(FORMS[sec])) if (!k.startsWith("$")) { exact[k] = key(v.one_off, v.annual); pairs.add(exact[k]); }
  }
  for (const [k, v] of Object.entries(FORMS.consultant_plans)) { exact[`consultant:${k}`] = key(null, v.annual); pairs.add(exact[`consultant:${k}`]); }
  exact["consultant:seat"] = key(null, FORMS.consultant_seat_annual);
  pairs.add(exact["consultant:seat"]);

  test("every pack price is the table's", () => {
    const cat = JSON.parse(readFileSync(path.join(ROOT, "data/catalogue.json"), "utf8"));
    const { monthly_factor: f, monthly_round_to_aud: r } = FORMS.billing;
    let n = 0;
    for (const p of cat.packs) {
      if (!p.prices) continue;
      n++;
      const k = key(p.prices.one_off ?? null, p.prices.annual ?? null);
      if (exact[p.id]) assert.equal(k, exact[p.id], `${p.id}: not the table's price`);
      else assert.ok(pairs.has(k), `${p.id}: ${k} is not a price in the pinned FORMS table`);
      if (p.prices.annual && p.prices.monthly != null) {
        assert.equal(p.prices.monthly, Math.floor((p.prices.annual * f) / 12 / r + 0.5) * r, `${p.id}: monthly`);
      }
    }
    assert.ok(n > 100, "the catalogue has priced packs");
    assert.equal(cat.price_table.revision, FORMS.revision);
    assert.deepEqual(cat.price_table.purchasable_waves, FORMS.purchasable_waves);
    assert.equal(cat.price_table.single_document.one_off_aud, FORMS.flat["single-document"].one_off);
  });
});
