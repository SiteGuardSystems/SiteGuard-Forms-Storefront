// The public catalogue for the SiteGuard Org AI (FORMS queue S9 / Rev10 X1):
// dist/assets/catalogue.json, served at https://www.siteguardforms.com.au/assets/catalogue.json.
//
// It lists the packs the shop pages show, with the page each one is on, so the
// BDM can link a prospect to the right pack without reading anything private.
// It's made from the same model the pages are built from (shopModel), so it
// can't drift from them; test/public-catalogue.test.js builds the site and
// checks every entry against the built pages, both ways.
//
// What it holds: pack id, name, group, trade (code and name), level, the page
// URL with the pack's anchor, and whether it can be ordered right now. No
// prices (they're on the pages), no document lists, nothing private.
import { groups, packSlug, LEVEL_LABEL } from "./shop.mjs";

export const PUBLIC_CATALOGUE_SCHEMA = "siteguard-forms-public-catalogue/1";
export const PUBLIC_CATALOGUE_PATH = "assets/catalogue.json";

/**
 * @param {object} cat    the catalogue as the pages use it (after the sellable list)
 * @param {object} model  shopModel(cat)
 * @param {object} opts   { origin, beta }
 */
export function publicCatalogue(cat, model, { origin, beta = false }) {
  const G = groups("");
  const trades = new Map(cat.trades.map((t) => [t.code, t]));
  const packs = [];
  for (const p of model.shown) {
    if (p.group === "consultants" && (!model.consultantsOn || p.id === "consultant:seat")) continue;
    const meta = G[p.group];
    if (!meta) continue;
    const t = p.trade ? trades.get(p.trade) : null;
    // Trade and specialist packs with a trade have a page per trade; every
    // other pack is on its group's page (shop.mjs shopPages).
    const pagePath = t && (p.group === "trade-packs" || p.group === "specialist-packs") ? `${meta.path}${t.slug}/` : meta.path;
    packs.push({
      id: p.id,
      name: p.name,
      group: p.group,
      trade: t ? { code: t.code, name: t.name } : null,
      level: p.level ?? null,
      level_label: p.level ? LEVEL_LABEL[p.level] ?? null : null,
      url: `${origin}${pagePath}#${packSlug(p.id)}`,
      page: pagePath,
      anchor: packSlug(p.id),
      orderable_now: !cat.preview && !beta && p.sellable === true && p.purchasable !== false,
    });
  }
  return {
    schema: PUBLIC_CATALOGUE_SCHEMA,
    site: origin,
    catalogue_generated_at: cat.generated_at ?? null,
    dcr_revision: cat.dcr_revision ?? null,
    preview: cat.preview === true,
    beta,
    count: packs.length,
    packs,
  };
}
