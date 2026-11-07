// The go-live sellable list (go-live brief Rev02, 5.2 and Session 5 L1): only
// packs on Dan's "sellable now" list are shown or sold, and no held document
// is sold on its own. data/sellable-now.json is made from the list's CSV by
// scripts/import-sellable-list.mjs (never by hand): pack ids and document
// codes only, no titles or prices.
//
// The list only ever NARROWS what data/catalogue.json (Hseq-Dev
// build_catalogue.py) puts on sale; it never puts on sale something the
// catalogue doesn't. Titles, prices and contents still come from the catalogue
// and the pinned DCR. A pack the catalogue sells but the list doesn't is
// hidden (show false) and refused at checkout (sellable false); a document
// that is held, or not on the list, can't be bought singly.
import { readFileSync } from "node:fs";

/** Reads and checks data/sellable-now.json. Throws on anything off-shape. */
export function loadSellableList(file) {
  const list = JSON.parse(readFileSync(file, "utf8"));
  const ids = (a) => Array.isArray(a) && a.every((x) => typeof x === "string" && x.length > 0);
  if (list?.schema !== 1) throw new Error(`${file}: schema must be 1`);
  if (!ids(list.packs_sellable_now)) throw new Error(`${file}: packs_sellable_now must be a list of pack ids`);
  if (!ids(list.documents)) throw new Error(`${file}: documents must be a list of document codes`);
  if (!ids(list.held_documents)) throw new Error(`${file}: held_documents must be a list of document codes`);
  return list;
}

/** Nothing on sale: what a missing or unreadable list means (fail closed). */
export const EMPTY_LIST = Object.freeze({ schema: 1, packs_sellable_now: [], documents: [], held_documents: [] });

/** A copy of the catalogue with the list applied (narrowing only). */
export function applySellableList(cat, list) {
  const packs = new Set(list.packs_sellable_now);
  const docs = new Set(list.documents);
  const held = new Set(list.held_documents);
  return {
    ...cat,
    sellable_list: { revision: list.revision ?? null, source: list.source ?? null },
    packs: cat.packs.map((p) => (packs.has(p.id) ? p : { ...p, show: false, sellable: false })),
    documents: cat.documents.map((d) => (docs.has(d.code) && !held.has(d.code) ? d : { ...d, sellable: false })),
  };
}
