// Bundles applied at checkout, read from the price table (Hseq-Dev
// docs/pricing/forms_price_table.json `bundles`, in the public view pinned by
// pricing.lock: vendor/hseq-dev/pricing/forms_price_table.public.json).
//
// builder_plus_trade (Dan, 24 Nov 2026, package suite audit P6): a builder pack
// bought with one trade pack in the same order takes discount_pct off the pair.
// One-off purchases only: /api/checkout is the one-off cart (mode "payment");
// FORMS subscriptions never come through it.
//
// The server derives the bundle from the cart's pack ids and the table. The
// browser can't claim it, and nothing it sends (a price, a discount, a bundle
// name) is read. No `bundles.builder_plus_trade` in the table (or the table
// unreadable, or malformed) means no discount.
//
// The rule as built (one bundle per order):
//   * the builder pack: the cart's most expensive pack matching `builder`;
//   * the trade pack(s): the cart's most expensive packs matching `trade`, up to
//     `max_trade_packs` (1 in Rev09). Ties keep cart order;
//   * each paired line's price is cut by discount_pct, rounded to the cent;
//   * every other line (a second builder pack, more trade packs, single
//     documents, management systems) is charged in full.
// A trade pack is any pack id matching `trade` ("subcontractor:*:*" in Rev09),
// so the specialist packs (also subcontractor:<code>:<level>) qualify too.
import { readFileSync } from "node:fs";

export const BUNDLE_ID = "builder_plus_trade";

/** True when a pack id matches a table pattern: colon-separated parts, "*" matching any one part. */
export function idMatches(pattern, id) {
  if (typeof pattern !== "string" || typeof id !== "string") return false;
  const want = pattern.split(":");
  const got = id.split(":");
  return want.length === got.length && want.every((w, i) => w === "*" ? got[i] !== "" : w === got[i]);
}

/** The builder + trade rule from a FORMS price table (or its public view), or null. */
export function bundleRule(table) {
  const b = table?.bundles?.[BUNDLE_ID];
  if (!b || typeof b !== "object") return null;
  const pct = b.discount_pct;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  if (typeof b.builder !== "string" || typeof b.trade !== "string" || !b.builder || !b.trade) return null;
  const max = b.max_trade_packs ?? 1;
  if (!Number.isInteger(max) || max < 1) return null;
  return { id: BUNDLE_ID, discount_pct: pct, builder: b.builder, trade: b.trade, max_trade_packs: max };
}

/** The rule from the price table view on disk; null (no discount) if it can't be read. */
export function readBundleRule(viewPath) {
  if (!viewPath) return null;
  try {
    return bundleRule(JSON.parse(readFileSync(viewPath, "utf8")));
  } catch (err) {
    console.error(`Price table view unreadable, no bundle discount: ${err.message}`);
    return null;
  }
}

/** The lines (from resolveCartEntry: { unit_amount, metadata: { packageId } }) with the
 *  bundle applied, as new objects. Lines the bundle doesn't touch come back unchanged. */
export function applyBundle(lines, rule) {
  if (!rule) return lines;
  const byPrice = (pattern) => lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => idMatches(pattern, line.metadata?.packageId))
    .sort((a, b) => b.line.unit_amount - a.line.unit_amount || a.i - b.i);
  const builder = byPrice(rule.builder)[0];
  const trades = byPrice(rule.trade).filter((t) => t.i !== builder?.i).slice(0, rule.max_trade_packs);
  if (!builder || trades.length === 0) return lines;
  const paired = new Set([builder.i, ...trades.map((t) => t.i)]);
  const pct = rule.discount_pct;
  return lines.map((line, i) => paired.has(i)
    ? {
      ...line,
      unit_amount: Math.round((line.unit_amount * (100 - pct)) / 100),
      description: `${line.description} · Builder + trade bundle: ${pct}% off`,
      metadata: { ...line.metadata, bundle: rule.id, list_amount: String(line.unit_amount) },
    }
    : line);
}
