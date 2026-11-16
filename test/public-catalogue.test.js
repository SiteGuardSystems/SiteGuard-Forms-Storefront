// FORMS queue S9 (Rev10 X1): dist/assets/catalogue.json, the public pack list
// the Org AI links prospects to. Built from the same model as the pages; this
// test builds the site and checks the JSON against the built pages both ways.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicCatalogue, PUBLIC_CATALOGUE_SCHEMA } from "../scripts/lib/public-catalogue.mjs";
import { shopModel } from "../scripts/lib/shop.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function htmlFiles(dir, rel = "") {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await htmlFiles(dir, r)));
    else if (e.name.endsWith(".html")) out.push(r);
  }
  return out;
}

test("assets/catalogue.json matches the built pack pages, both ways", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-pubcat-"));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], { cwd: ROOT, env: { ...process.env, DIST_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pub = JSON.parse(await readFile(path.join(dir, "assets/catalogue.json"), "utf8"));
    assert.equal(pub.schema, PUBLIC_CATALOGUE_SCHEMA);
    assert.equal(pub.count, pub.packs.length);
    assert.ok(pub.packs.length > 0, "the shop lists packs");

    // Every entry: its page exists, carries the pack's anchor and its name.
    for (const p of pub.packs) {
      assert.ok(p.url.endsWith(`${p.page}#${p.anchor}`), `${p.id}: url is page + anchor`);
      const html = await readFile(path.join(dir, p.page, "index.html"), "utf8");
      assert.ok(html.includes(`id="${p.anchor}"`), `${p.id}: ${p.page} has #${p.anchor}`);
      assert.ok(html.includes(`data-add-pack="${p.id}"`) || html.includes(`id="${p.anchor}"`), `${p.id}: on ${p.page}`);
    }

    // Every pack offered on a built page (an "Add to cart" button or a
    // consultant plan row) is in the JSON, on that page.
    const listed = new Map(pub.packs.map((p) => [p.id, p]));
    for (const f of await htmlFiles(dir)) {
      if (f.startsWith("cart/") || f.startsWith("order/")) continue;
      const html = await readFile(path.join(dir, f), "utf8");
      const page = "/" + f.replace(/index\.html$/, "");
      for (const [, id] of html.matchAll(/data-add-pack="([^"]+)"/g)) {
        assert.ok(listed.has(id), `${page} offers ${id}, which isn't in catalogue.json`);
        assert.equal(listed.get(id).page, page, `${id} is on ${page}, catalogue.json says ${listed.get(id).page}`);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalogue.json holds no prices, document lists or private fields", async () => {
  const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
  const pub = publicCatalogue(cat, shopModel(cat), { origin: "https://example.test", beta: false });
  const allowed = ["id", "name", "group", "trade", "level", "level_label", "url", "page", "anchor", "orderable_now"];
  for (const p of pub.packs) assert.deepEqual(Object.keys(p), allowed);
  const text = JSON.stringify(pub);
  assert.ok(!/price|"documents"|summary|includes|\$\d/i.test(text), "no prices, document lists or marketing copy");
  assert.deepEqual(Object.keys(pub), ["schema", "site", "catalogue_generated_at", "dcr_revision", "preview", "beta", "count", "packs"]);
});

test("orderable_now is false while FORMS is in beta, and never true for a pack that can't be bought", async () => {
  const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
  const model = shopModel(cat);
  assert.ok(publicCatalogue(cat, model, { origin: "https://x.test", beta: true }).packs.every((p) => !p.orderable_now));
  const open = publicCatalogue(cat, model, { origin: "https://x.test", beta: false });
  const byId = new Map(cat.packs.map((p) => [p.id, p]));
  for (const p of open.packs) {
    const src = byId.get(p.id);
    assert.equal(p.orderable_now, !cat.preview && src.sellable === true && src.purchasable !== false, p.id);
  }
});
