// Trade compliance packs (compliance:<TRADE>) on the shop (Dan, 1 Nov 2026).
// The committed catalogue does not list them yet: Hseq-Dev build_catalogue.py
// writes listed=false for them. These tests build the site from a copy of the
// committed catalogue with only that flag set as the generator would set it
// (listed, and show = listed && sellable), and check the shop shows them like
// the trade level rungs, at the catalogue's own name and price.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
const isCompliance = (p) => p.id.startsWith("compliance:");
const amp = (s) => s.replace(/&/g, "&amp;");

let dir, cat;
const html = (rel) => readFile(path.join(dir, "dist", rel, "index.html"), "utf8");
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sg-compliance-"));
  cat = structuredClone(committed);
  for (const p of cat.packs) if (isCompliance(p)) { p.listed = true; p.show = p.listed && (p.sellable || cat.preview); }
  await writeFile(path.join(dir, "catalogue.json"), JSON.stringify(cat));
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], {
    env: { ...process.env, CATALOGUE_PATH: path.join(dir, "catalogue.json"), DIST_DIR: path.join(dir, "dist") }, stdio: "pipe",
  });
});
after(() => rm(dir, { recursive: true, force: true }));

test("the committed catalogue has trade compliance packs, sellable but not listed", () => {
  const packs = committed.packs.filter(isCompliance);
  assert.ok(packs.length > 0);
  assert.ok(packs.some((p) => p.sellable && p.prices));
  // When the generator lists them this starts failing: drop it then.
  assert.ok(packs.every((p) => !p.listed && !p.show));
});

test("a listed compliance pack is on its trade's page, after the level rungs, at the catalogue's price", async () => {
  const shown = cat.packs.filter((p) => isCompliance(p) && p.show && p.prices);
  assert.ok(shown.length > 0);
  for (const p of shown) {
    const t = cat.trades.find((x) => x.code === p.trade);
    const h = await html(`${t.group}/${t.slug}`);
    assert.ok(h.includes(`<h3>${amp(p.name)}</h3>`), `${p.id}: heading`);
    assert.ok(h.includes(`data-add-pack="${p.id}" data-name="${amp(p.name)}" data-price="${p.prices.one_off}"`), `${p.id}: outright price`);
    assert.ok(h.includes(`price=${p.prices.annual}`) && h.includes(`price=${p.prices.monthly}`), `${p.id}: subscription prices`);
    const rungs = [...h.matchAll(/<article class="rung" id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(rungs.at(-1), p.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), `${p.id}: after the level rungs`);
  }
});

test("trade and specialist index rows name every pack, and count the trade's own SWMS", async () => {
  for (const g of ["trade-packs", "specialist-packs"]) {
    const t = text(await html(g));
    assert.ok(!/undefined|, ,|, \./.test(t), `${g}: an empty pack label`);
    assert.match(t, /Heavy Commercial, Compliance Pack/);
  }
  const carp = cat.packs.find((p) => p.id === "subcontractor:CARP:heavy-commercial");
  const own = carp.includes.find((x) => / SWMS$/.test(x) && !/core/.test(x)).replace("Carpentry ", "");
  assert.match(text(await html("trade-packs")), new RegExp(`Compliance Pack\\. ${own} for the trade\\.`));
});

test("a specialist trade's compliance pack counts in the specialist range on the home page", async () => {
  const home = text(await html(""));
  const count = (g) => {
    const tradeGroup = new Map(cat.trades.map((t) => [t.code, t.group]));
    return cat.packs.filter((p) => p.show && p.prices && ((p.trade && tradeGroup.get(p.trade)) || p.group) === g).length;
  };
  assert.match(home, new RegExp(`View trade packs`));
  assert.ok(home.includes(`${count("trade-packs")} packages View trade packs`));
  assert.ok(home.includes(`${count("specialist-packs")} packages View specialist packs`));
});
