#!/usr/bin/env node
// Provisions the SiteGuard App's Stripe products and prices from
// data/app-billing.json (Pricing Rev06): per product one recurring price per
// billing cadence (annual default; 6-monthly +3%, quarterly +5%, monthly +8%)
// and one one-time "founding" price (12 months less the founding discount).
// Every price is A$ ex GST with tax_behavior "exclusive": Stripe Tax adds GST.
//
// Idempotent and price-aware: a changed amount gets a new Price and the old
// one is archived (subscriptions on it are untouched; its id stays in
// byPriceId so the webhook still recognises it).
//
// TEST MODE ONLY until Dan's go: a live key is refused unless --confirm-live.
// Gated products (CORE, SiteGuard AI, robotics, NZ/overseas) are never in
// the config; --audit-gated lists any active Stripe product that looks gated,
// and --archive-gated (test mode only) archives them.
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/sync-app-stripe.mjs [--audit-gated] [--archive-gated] [--ensure-test-tax-registration]
import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppBilling, pricesFor, foundingAmountCents, CADENCE_ORDER } from "../lib/app-billing.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!key) { console.error("STRIPE_SECRET_KEY is not set"); process.exit(2); }
const testMode = key.startsWith("sk_test_") || key.startsWith("rk_test_");
if (!testMode && !process.argv.includes("--confirm-live")) {
  console.error("Refusing: this is not a Stripe TEST key. Live mode needs Dan's explicit go (--confirm-live)."); process.exit(3);
}
const arg = (f) => process.argv.includes(f);
const stripe = new Stripe(key);
const cfg = validateAppBilling(JSON.parse(readFileSync(path.join(ROOT, "data/app-billing.json"), "utf8")));
const outPath = path.join(ROOT, "data", `app-billing-stripe.${testMode ? "test" : "live"}.json`);
const previous = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { byProductId: {}, byPriceId: {} };

// Words that mark a gated product. "Core Management System" is a FORMS pack, not CORE.
export const GATED_RE = /\b(siteguard\s+core|core\s+(module|project|suite|platform)|siteguard\s+ai|ai\s+role|robot|robotics|new\s+zealand|\bnz\b|singapore|overseas)\b/i;

async function findProduct(appProductId) {
  // The mapping file first: Stripe's search index lags new products by up to a minute.
  const known = previous.byProductId?.[appProductId]?.stripe_product_id;
  if (known) {
    const p = await stripe.products.retrieve(known).catch(() => null);
    if (p && !p.deleted) return p;
  }
  const r = await stripe.products.search({ query: `metadata['app_product_id']:'${appProductId}'`, limit: 1 });
  return r.data[0] ?? null;
}

async function ensurePrice(product, appProductId, cadenceName, amountCents, recurring) {
  const existing = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const same = existing.data.filter((p) => p.metadata.cadence === cadenceName);
  let price = same.find((p) => p.unit_amount === amountCents && p.currency === "aud" &&
    (recurring ? p.recurring?.interval === recurring.interval && p.recurring?.interval_count === recurring.interval_count : !p.recurring));
  let created = false;
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      currency: "aud",
      unit_amount: amountCents,
      tax_behavior: "exclusive",
      ...(recurring ? { recurring } : {}),
      nickname: `${appProductId} ${cadenceName}`,
      metadata: { app_product_id: appProductId, cadence: cadenceName, pricing_revision: cfg.pricing_revision },
    });
    created = true;
  }
  const archived = [];
  for (const old of same) {
    if (old.id !== price.id) { await stripe.prices.update(old.id, { active: false }); archived.push(old.id); }
  }
  return { price, created, archived };
}

async function main() {
  const byProductId = {};
  const byPriceId = { ...(previous.byPriceId ?? {}) };
  let created = 0;
  let archived = 0;
  for (const p of cfg.products) {
    const meta = { app_product_id: p.id, group: p.group, per: p.per, pricing_revision: cfg.pricing_revision };
    let product = await findProduct(p.id);
    if (!product) {
      product = await stripe.products.create({ name: p.name, tax_code: "txcd_10103001", metadata: meta,
        unit_label: p.per === "seat" ? "seat" : undefined });
      created++;
    } else if (product.name !== p.name || !product.active) {
      product = await stripe.products.update(product.id, { name: p.name, active: true, metadata: meta });
    }
    const amounts = pricesFor(cfg, p);
    const prices = {};
    for (const name of CADENCE_ORDER) {
      const c = cfg.cadences[name];
      if (!c) continue;
      const r = await ensurePrice(product, p.id, name, amounts[name], { interval: c.stripe_interval, interval_count: c.stripe_interval_count });
      prices[name] = r.price.id;
      byPriceId[r.price.id] = { app_product_id: p.id, cadence: name, unit_amount: amounts[name] };
      created += r.created ? 1 : 0;
      archived += r.archived.length;
    }
    const f = await ensurePrice(product, p.id, "founding", foundingAmountCents(cfg, p), null);
    prices.founding = f.price.id;
    byPriceId[f.price.id] = { app_product_id: p.id, cadence: "founding", unit_amount: foundingAmountCents(cfg, p) };
    created += f.created ? 1 : 0;
    archived += f.archived.length;
    byProductId[p.id] = { stripe_product_id: product.id, name: p.name, prices, amounts_cents_ex_gst: { ...amounts, founding: foundingAmountCents(cfg, p) } };
    process.stdout.write(".");
  }
  writeFileSync(outPath, JSON.stringify({ mode: testMode ? "test" : "live", pricing_revision: cfg.pricing_revision, byProductId, byPriceId }, null, 2) + "\n");
  console.log(`\n${cfg.products.length} app products synced (${created} objects created, ${archived} old prices archived). Wrote ${path.relative(ROOT, outPath)}.`);

  if (arg("--audit-gated") || arg("--archive-gated")) {
    const hits = [];
    for await (const prod of stripe.products.list({ active: true, limit: 100 })) {
      if (GATED_RE.test(`${prod.name} ${prod.description ?? ""} ${JSON.stringify(prod.metadata)}`)) hits.push(prod);
    }
    console.log(`Gated-product audit: ${hits.length} active product(s) look gated.`);
    for (const h of hits) {
      console.log(`  ${h.id} ${h.name}`);
      if (arg("--archive-gated")) {
        if (!testMode) { console.log("  (not archived: live mode)"); continue; }
        await stripe.products.update(h.id, { active: false });
        console.log("  archived");
      }
    }
  }

  if (arg("--ensure-test-tax-registration")) {
    if (!testMode) { console.log("--ensure-test-tax-registration is test mode only"); return; }
    const regs = await stripe.tax.registrations.list({ status: "all", limit: 100 });
    if (regs.data.some((r) => r.country === "AU" && r.status === "active")) console.log("Test mode: AU tax registration already active.");
    else {
      await stripe.tax.registrations.create({ country: "AU", country_options: { au: { type: "standard" } }, active_from: "now" });
      console.log("Test mode: AU (GST) tax registration created so Stripe Tax adds GST in test checkouts.");
    }
  }
}

main().catch((err) => { console.error("FAILED:", err.message); process.exitCode = 1; });
