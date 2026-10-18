// Checks on the built site in dist/ (npm test builds it first).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BANNED } from "../scripts/build-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));

async function htmlFiles(dir = DIST) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await htmlFiles(p)));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}
const files = await htmlFiles();
const pages = await Promise.all(files.map(async (f) => ({ f: path.relative(DIST, f), html: await readFile(f, "utf8") })));

test("every page has a title, description, canonical, one h1 and no inline script or style", () => {
  for (const { f, html } of pages) {
    assert.match(html, /<title>[^<]+<\/title>/, f);
    assert.match(html, /<meta name="description" content="[^"]{20,}">/, f);
    assert.match(html, /<link rel="canonical" href="https:\/\/[^"]+">/, f);
    assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1, f);
    assert.ok(!/<script(?![^>]*(src=|application\/ld\+json))[^>]*>/.test(html), `${f}: inline script`);
    assert.ok(!/ style="/.test(html), `${f}: inline style attribute`);
    assert.match(html, /class="skip" href="#main"/, f);
  }
});

test("titles are unique", () => {
  const t = pages.map((p) => p.html.match(/<title>([^<]+)/)[1]);
  assert.equal(new Set(t).size, t.length);
});

test("marketing pages carry none of the banned words", () => {
  for (const { f, html } of pages) {
    if (f.startsWith("legal/")) continue;
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/Certified Lead Auditor/g, "");
    assert.equal(text.match(BANNED), null, f);
  }
});

test("only packs the catalogue puts on show appear, at the catalogue's price", () => {
  const all = pages.map((p) => p.html).join("\n");
  for (const p of cat.packs) {
    const onPage = all.includes(`data-add-pack="${p.id}"`) || all.includes(`pack=${encodeURIComponent(p.id)}&`);
    assert.equal(onPage, Boolean(p.show && p.prices), p.id);
    if (onPage && p.prices.one_off) {
      assert.ok(all.includes(`data-add-pack="${p.id}" data-name="${p.name.replace(/&/g, "&amp;")}" data-price="${p.prices.one_off}"`), p.id);
    }
  }
  for (const id of ["builder:iso-ofsc", "full-library"]) assert.ok(!all.includes(id), id);
  assert.ok(!/OFSC-[A-Z]{3}-/.test(all), "an OFSC document code appears on a page");
});

test("preview builds say so and are not indexed; live builds are", async () => {
  const home = pages.find((p) => p.f === "index.html").html;
  const robots = await readFile(path.join(DIST, "robots.txt"), "utf8");
  if (cat.preview) {
    assert.match(home, /Preview build/);
    assert.match(home, /noindex/);
    assert.match(robots, /Disallow: \//);
  } else {
    assert.ok(!/Preview build/.test(home));
    assert.match(robots, /Sitemap:/);
  }
});

test("the cart asks for the checkout notice tick box", () => {
  const cart = pages.find((p) => p.f === "cart/index.html").html;
  assert.match(cart, /<input type="checkbox" name="accept" aria-required="true">/);
  assert.match(cart, /Terms of Sale/);
});

test("sitemap lists the shop pages and no cart or order pages", async () => {
  const sm = await readFile(path.join(DIST, "sitemap.xml"), "utf8");
  assert.match(sm, /<loc>https:\/\/[^<]+\/trade-packs\/<\/loc>/);
  assert.ok(!/\/cart\/|\/order\//.test(sm));
});

test("consultant pages and links appear only when a consultant plan is on show", () => {
  const on = cat.packs.some((p) => p.group === "consultants" && p.id !== "consultant:seat" && p.show && p.prices);
  const all = pages.map((p) => p.html).join("\n");
  assert.equal(pages.some((p) => p.f === "consultants/index.html"), on);
  assert.equal(all.includes('href="/consultants/"'), on);
  // Legal pages are solicitor-controlled and change only through the legal suite.
  const marketing = pages.filter((p) => !p.f.startsWith("legal/")).map((p) => p.html).join("\n");
  assert.ok(!/\b(T1|T2)\b/.test(marketing.replace(/<script[\s\S]*?<\/script>/g, "")), "old consultant tier names on a page");
});
