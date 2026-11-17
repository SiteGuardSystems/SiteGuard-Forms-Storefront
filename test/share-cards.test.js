// FORMS queue S12: share cards. Every built page has Open Graph and Twitter
// tags; every pack and trade page has its own 1200x630 card; no card names a
// price; og:url carries utm tags while the canonical link stays clean.
// (npm test builds dist/ first.)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cardsFor, shareUrl, CARD_DIR, DEFAULT_CARD } from "../scripts/lib/share-cards.mjs";
import { shopModel } from "../scripts/lib/shop.mjs";
import { loadSellableList, applySellableList } from "../lib/sellable-list.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

async function htmlFiles(dir = DIST, rel = "") {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await htmlFiles(dir, r)));
    else if (e.name.endsWith(".html")) out.push(r);
  }
  return out;
}
const pngSize = (buf) => ({ sig: buf.subarray(1, 4).toString("ascii"), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const meta = (html, attr, key) => (new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`).exec(html) ?? [])[1];

function cards() {
  const cat = applySellableList(JSON.parse(readFileSync(path.join(ROOT, "data/catalogue.json"), "utf8")), loadSellableList(path.join(ROOT, "data/sellable-now.json")));
  return cardsFor(cat, shopModel(cat));
}

test("every built page has the Open Graph and Twitter tags", async () => {
  const files = await htmlFiles();
  assert.ok(files.length > 20);
  for (const f of files) {
    const html = await readFile(path.join(DIST, f), "utf8");
    for (const k of ["og:title", "og:description", "og:url", "og:image", "og:image:alt"]) assert.ok(meta(html, "property", k), `${f}: ${k}`);
    for (const k of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) assert.ok(meta(html, "name", k), `${f}: ${k}`);
  }
});

test("every pack and trade page uses its own 1200x630 PNG card, which exists", async () => {
  const want = cards();
  assert.ok(want.size >= 5, "trade pages and ranges have cards");
  for (const [url, c] of want) {
    const file = path.join(ROOT, "public", CARD_DIR, c.file);
    assert.ok(existsSync(file), `${c.file} exists (npm run share-cards)`);
    const { sig, w, h } = pngSize(await readFile(file));
    assert.deepEqual({ sig, w, h }, { sig: "PNG", w: 1200, h: 630 }, c.file);
    const html = await readFile(path.join(DIST, url, "index.html"), "utf8");
    assert.equal(meta(html, "property", "og:image"), `https://www.siteguardforms.com.au/${CARD_DIR}/${c.file}`, url);
    assert.equal(meta(html, "name", "twitter:card"), "summary_large_image", url);
  }
  assert.ok(existsSync(path.join(ROOT, "public", CARD_DIR, DEFAULT_CARD.file)), "the default card exists");
});

test("no card names a price", () => {
  for (const c of [DEFAULT_CARD, ...cards().values()]) {
    const text = `${c.title} ${c.line} ${c.sub}`;
    assert.doesNotMatch(text, /\$|\bAUD\b|\bA\$|\d{2,}|price|GST/i, c.file);
  }
});

test("og:url carries utm tags; the canonical link stays clean", async () => {
  const html = await readFile(path.join(DIST, "trade-packs/carpentry/index.html"), "utf8");
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.siteguardforms\.com\.au\/trade-packs\/carpentry\/">/);
  assert.equal(meta(html, "property", "og:url"), "https://www.siteguardforms.com.au/trade-packs/carpentry/?utm_source=social&amp;utm_medium=share&amp;utm_campaign=trade-packs-carpentry");
  assert.equal(shareUrl("https://x.test", "/"), "https://x.test/?utm_source=social&utm_medium=share&utm_campaign=home");
});
