#!/usr/bin/env node
// Prints the SiteGuard App Stripe price list offline: no key, no network.
// These are exactly the prices scripts/sync-app-stripe.mjs creates in Stripe
// TEST mode, read from data/app-catalogue.json (Hseq-Dev, Dan's decision #90).
// With the current mapping file it also lists every Stripe price whose
// recorded amount is not the price list's (the checkout refuses those until
// sync-app-stripe is re-run with a TEST key).
//
//   node scripts/app-price-list.mjs [--json] [--mapping data/app-billing-stripe.test.json]
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripePriceList } from "../lib/app-billing.js";
import { loadAppBilling } from "../lib/app-prices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (f) => { const i = process.argv.indexOf(f); return i < 0 ? null : process.argv[i + 1]; };
const cfg = loadAppBilling();
const list = stripePriceList(cfg);
const mapFile = path.resolve(ROOT, arg("--mapping") ?? "data/app-billing-stripe.test.json");
const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : null;
const stale = [];
for (const p of list) {
  const had = map?.byProductId?.[p.app_product_id]?.amounts_cents_ex_gst?.[p.cadence];
  if (had !== undefined && had !== p.unit_amount) stale.push({ ...p, mapped_amount: had, price_id: map.byProductId[p.app_product_id].prices?.[p.cadence] });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ pricing_revision: cfg.pricing_revision, prices: list, stale_in_mapping: stale }, null, 2));
} else {
  const aud = (c) => `A$${(c / 100).toFixed(2)}`;
  console.log(`SiteGuard App Stripe prices, ${cfg.pricing_revision}, A$ ex GST (Stripe Tax adds GST):`);
  for (const p of list) {
    const every = p.recurring ? `every ${p.recurring.interval_count} ${p.recurring.interval}(s)` : "one-time";
    console.log(`  ${p.app_product_id.padEnd(30)} ${p.cadence.padEnd(12)} ${aud(p.unit_amount).padStart(12)}  ${every}`);
  }
  console.log(stale.length
    ? `\n${stale.length} price(s) in ${path.relative(ROOT, mapFile)} are not the price list's (checkout refuses them until sync-app-stripe is re-run with a TEST key):`
    : `\n${path.relative(ROOT, mapFile)}: every recorded amount matches.`);
  for (const s of stale) console.log(`  ${s.app_product_id} ${s.cadence}: ${aud(s.mapped_amount)} -> ${aud(s.unit_amount)} (${s.price_id})`);
}
