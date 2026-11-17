// FORMS queue S14: How delivery works (/how-delivery-works/), linked from every
// pack page. npm test builds dist/ first.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { groups, shopModel } from "../scripts/lib/shop.mjs";
import { loadSellableList, applySellableList } from "../lib/sellable-list.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the page walks through paid → details → prepared and checked → emailed within 3 business days → lost documents", async () => {
  const html = await readFile(path.join(DIST, "how-delivery-works/index.html"), "utf8");
  const t = text(html);
  for (const step of ["1. You pay", "2. You send us your details", "3. We prepare and check your pack", "4. It's emailed to you", "5. Lost them later?"]) assert.ok(t.includes(step), step);
  assert.match(t, /within 3 business days of your details being in/);
  assert.doesNotMatch(t, /instant|download now|in minutes|straight away to download/i);
  // Until S10's /lost-documents/ is in the build, step 5 points at the contact page.
  const lost = existsSync(path.join(DIST, "lost-documents/index.html"));
  assert.ok(html.includes(lost ? 'href="/lost-documents/"' : 'href="/contact/"'));
});

test("every pack page links to How delivery works", async () => {
  const cat = applySellableList(JSON.parse(readFileSync(path.join(ROOT, "data/catalogue.json"), "utf8")), loadSellableList(path.join(ROOT, "data/sellable-now.json")));
  const model = shopModel(cat);
  const G = groups("");
  const urls = [...model.trades.map((t) => `${G[t.group].path}${t.slug}/`), ...["builder-packs", "management-systems", "specialist-packs"].filter((g) => model.inGroup(g).length).map((g) => G[g].path)];
  assert.ok(urls.length > 5);
  for (const u of urls) {
    const html = await readFile(path.join(DIST, u, "index.html"), "utf8");
    assert.ok(html.includes('<a href="/how-delivery-works/">How delivery works</a>'), u);
  }
});
