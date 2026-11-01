// Dan's decision #90 (1 Nov 2026): ONE price source, Hseq-Dev packages.py via
// docs/pricing/. This repo is PUBLIC, so it pins Hseq-Dev's PUBLIC VIEW of the
// two price tables (pricing.lock + vendor/hseq-dev/pricing/*.public.json, from
// docs/pricing/export_price_tables.py --storefront), never the full tables
// (internal codes, held or unreleased pack prices, notes). It must sell at
// exactly the pinned figures: the app prices (data/app-catalogue.json, Stripe
// TEST prices, the founding prepayment) and the FORMS shop prices
// (data/catalogue.json). Nothing here calculates a price. To update:
// docs/pricing/README.md in Hseq-Dev.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripePriceList, validateAppBilling, CADENCE_ORDER } from "../lib/app-billing.js";
import { loadAppBilling, readAppCatalogue } from "../lib/app-prices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lf = (file) => readFileSync(path.join(ROOT, file)).toString("utf8").replace(/\r\n/g, "\n");
const LOCK = JSON.parse(lf("pricing.lock"));
const VIEW = Object.fromEntries(Object.entries(LOCK.files).map(([name, f]) => [name, JSON.parse(lf(f.vendored_at))]));
const APP = VIEW["app_price_table.public.json"];
const FORMS = VIEW["forms_price_table.public.json"];
const noComments = (o) => (Array.isArray(o) ? o.map(noComments)
  : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("$")).map(([k, v]) => [k, noComments(v)])) : o);
const keys = (o, out = new Set()) => {
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keys(v, out); }
  return out;
};
// What must never reach this public repo from Hseq-Dev's full tables (same checks as siteguard-website).
const PRIVATE = ["code", "components", "not_in_workbook", "dcr_packs", "launch_wave_rules", "consultant_plans",
  "consultant_seat_annual", "workbook_one_off", "workbook_annual", "management_bands", "add_ons", "source", "status"];
const PRIVATE_WORDS = [/\bDan\b/, /flagged/i, /PENDING/, /\bCORE\b/, /SiteGuard AI/, /robot/i, /OFSC/i, /\.xlsx/];

describe("pricing.lock: the pinned public view of Hseq-Dev's price tables", () => {
  test("each pinned copy hashes to the lock (sha256 of its LF form)", () => {
    assert.equal(LOCK.repo, "SiteGuardSystems/Hseq-Dev");
    assert.equal(LOCK.kind, "price-tables-public-view");
    assert.deepEqual(Object.keys(LOCK.files).sort(), ["app_price_table.public.json", "forms_price_table.public.json"]);
    for (const [name, f] of Object.entries(LOCK.files)) {
      assert.equal(f.vendored_at, `vendor/hseq-dev/pricing/${name}`);
      const got = createHash("sha256").update(lf(f.vendored_at)).digest("hex");
      assert.equal(got, f.sha256, `${f.vendored_at} is not the pinned ${name}: re-run Hseq-Dev docs/pricing/export_price_tables.py --storefront`);
      assert.match(f.source_sha256, /^[0-9a-f]{64}$/, `${name}: the full table it was cut from`);
    }
    assert.equal(APP.revision, LOCK.revision.app);
    assert.equal(FORMS.revision, LOCK.revision.forms);
  });

  test("a public repo: only the public view is vendored, with no internal codes, notes or unreleased prices", () => {
    assert.deepEqual(readdirSync(path.join(ROOT, "vendor/hseq-dev/pricing")).sort(), Object.keys(LOCK.files).sort());
    for (const [name, v] of Object.entries(VIEW)) {
      const ks = keys(v);
      assert.deepEqual(PRIVATE.filter((k) => ks.has(k)), [], name);
      const text = JSON.stringify(noComments(v));
      for (const w of PRIVATE_WORDS) assert.doesNotMatch(text, w, name);
    }
  });

  test("data/app-catalogue.json carries no internal notes either", () => {
    const cat = readAppCatalogue();
    assert.deepEqual([...keys(cat)].filter((k) => k.startsWith("$")), ["$comment"]);
    const ks = keys(cat);
    assert.deepEqual(["code", "not_in_workbook", "dcr_packs", "launch_wave_rules", "consultant_plans", "management_bands", "add_ons", "status"].filter((k) => ks.has(k)), []);
    for (const w of PRIVATE_WORDS.filter((w) => !/Dan/.test(String(w)))) assert.doesNotMatch(JSON.stringify(noComments(cat)), w);
  });
});

describe("app prices: data/app-catalogue.json is the pinned view", () => {
  const cat = readAppCatalogue();
  test("group \"app\" rows carry the view's app_prices exactly", () => {
    const packs = cat.packs.filter((p) => p.group === "app");
    assert.deepEqual(packs.map((p) => p.id).sort(), Object.keys(APP.products).sort());
    for (const p of packs) {
      assert.deepEqual(p.app_prices, APP.products[p.id].app_prices, p.id);
      assert.equal(p.name, APP.products[p.id].name, p.id);
      assert.equal(p.prices, null, "app products are never sold by the FORMS checkout");
    }
    for (const [k, v] of Object.entries(APP.header)) assert.deepEqual(noComments(cat.app[k]), v, `app.${k}`);
  });
});

describe("app billing sells at the view's figures, never its own", () => {
  const cfg = loadAppBilling();
  const ap = (id) => APP.products[id].app_prices;
  test("every cadence's period price and the founding prepayment", () => {
    for (const p of cfg.products) {
      assert.equal(p.monthly_aud, ap(p.id).per_month, p.id);
      for (const c of CADENCE_ORDER) assert.equal(p.prices_cents[c], ap(p.id).cadences[c].per_period * 100, `${p.id} ${c}`);
      assert.equal(p.founding_cents, ap(p.id).founding_prepay_cents, p.id);
    }
    assert.equal(cfg.founding.discount, APP.header.founding.discount);
    assert.equal(cfg.founding.places_total, APP.header.founding.places);
    assert.equal(cfg.founding.term_months, APP.header.founding.term_months);
  });
  test("loadings come from the view; the labels say the same", () => {
    for (const [name, c] of Object.entries(cfg.cadences)) {
      const want = name === "annual" ? 0 : APP.header.billing.loading[name];
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
    assert.equal(list.length, Object.keys(APP.products).length * 5);
    for (const p of list) {
      assert.equal(p.currency, "aud");
      assert.equal(p.tax_behavior, "exclusive");
      const a = ap(p.app_product_id);
      assert.equal(p.unit_amount, p.cadence === "founding" ? a.founding_prepay_cents : a.cadences[p.cadence].per_period * 100);
      assert.ok(Number.isInteger(p.unit_amount));
    }
    const monthly = list.find((p) => p.app_product_id === "app:trade:domestic" && p.cadence === "monthly");
    assert.deepEqual(monthly, { app_product_id: "app:trade:domestic", cadence: "monthly", currency: "aud", tax_behavior: "exclusive", unit_amount: 21200, recurring: { interval: "month", interval_count: 1 } });
  });
});

describe("FORMS prices: the shop's packs are the pinned view", () => {
  // Every pack the shop shows must be at a price the view states: a flat pack
  // exactly, a banded pack at one of the view's band rows (which band is
  // packages.py's call; Hseq-Dev's own drift test checks it), monthly by the rule.
  const cat = JSON.parse(readFileSync(path.join(ROOT, "data/catalogue.json"), "utf8"));
  const { monthly_factor: f, monthly_round_to_aud: r } = FORMS.billing;
  const pairs = new Set(Object.values(FORMS.bands).flat().map((b) => `${b.one_off}/${b.annual}`));
  const banded = /^(subcontractor:[A-Z]+:(domestic|light-commercial|heavy-commercial)|swms:[A-Z]+|compliance:[A-Z]+)$/;
  test("every shown pack is at the view's price", () => {
    const shown = cat.packs.filter((p) => p.show && p.prices);
    assert.ok(shown.length > 50, "the shop shows priced packs");
    for (const p of shown) {
      const k = `${p.prices.one_off ?? null}/${p.prices.annual ?? null}`;
      const flat = FORMS.flat[p.id];
      if (flat) assert.equal(k, `${flat.one_off}/${flat.annual}`, `${p.id}: not the table's price`);
      else {
        assert.match(p.id, banded, `${p.id}: shown, but neither a flat price nor a banded pack in the public view`);
        assert.ok(pairs.has(k), `${p.id}: ${k} is not a band in the pinned FORMS view`);
      }
      if (p.prices.annual != null) assert.equal(p.prices.monthly, Math.floor((p.prices.annual * f) / 12 / r + 0.5) * r, `${p.id}: monthly`);
      assert.ok(FORMS.purchasable_waves.includes(p.launch_wave), `${p.id}: shown outside a purchasable wave`);
    }
    assert.equal(cat.price_table.revision, FORMS.revision);
    assert.deepEqual(cat.price_table.purchasable_waves, FORMS.purchasable_waves);
    assert.equal(cat.price_table.monthly_factor, f);
    assert.equal(cat.price_table.monthly_round_to_aud, r);
    assert.equal(cat.price_table.single_document.one_off_aud, FORMS.flat["single-document"].one_off);
  });
});
