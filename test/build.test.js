// Checks on the built site in dist/ (npm test builds it first).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BANNED, GATED } from "../scripts/build-site.mjs";

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
// path.relative() returns OS-native separators; every other assertion in this
// file compares f against a forward-slash literal ("legal/", "cart/index.html"),
// so a backslash here (Windows) makes those checks never match -- silently
// skipping the banned-words check on legal pages instead of running it, and
// throwing on the cart lookup. Normalise once, here.
const pages = await Promise.all(files.map(async (f) => ({ f: path.relative(DIST, f).split(path.sep).join("/"), html: await readFile(f, "utf8") })));

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
    // The extra consultant seat is never bought on its own: the consultants page states its price
    // in the "Plans and users" text, beside the plans (build-site.mjs, extraSeat).
    if (p.id === "consultant:seat") {
      if (p.show && p.prices) assert.ok(all.includes("Extra users are"), "consultant seat price line missing");
      continue;
    }
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
    const beta = JSON.parse(await readFile(path.join(ROOT, "data/site-mode.json"), "utf8").catch(() => "{}")).beta === true;
    if (!beta) assert.match(robots, /Sitemap:/);   // beta keeps search engines out (separate test)
  }
});

test("the cart asks for the checkout notice tick box", () => {
  const cart = pages.find((p) => p.f === "cart/index.html").html;
  assert.match(cart, /<input type="checkbox" name="accept" aria-required="true">/);
  assert.match(cart, /Terms of Sale/);
});

test("the cart offers an optional, length-limited site name field", () => {
  const cart = pages.find((p) => p.f === "cart/index.html").html;
  assert.match(cart, /<label for="cart-site-name">Site name \(optional\)<\/label>/);
  assert.match(cart, /<input id="cart-site-name" name="siteName" type="text" maxlength="100"/);
  assert.doesNotMatch(cart, /name="siteName"[^>]*required/);
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

test("beta (data/site-mode.json): banner on every page, no indexing, nothing buyable", async () => {
  const mode = JSON.parse(await readFile(path.join(ROOT, "data/site-mode.json"), "utf8"));
  if (mode.beta !== true) return;
  for (const { f, html } of pages) {
    assert.match(html, /data-beta="1"/, f);
    assert.match(html, /SiteGuard FORMS is in beta/, f);
    assert.match(html, /noindex/, f);
    // every add-to-cart and subscribe control is disabled
    for (const m of html.matchAll(/<(?:button|a)[^>]*(?:data-add-pack|Subscribe (?:yearly|monthly))[^>]*>/g)) {
      assert.match(m[0], /data-preview-disabled/, `${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.equal((await readFile(path.join(DIST, "robots.txt"), "utf8")).trim(), "User-agent: *\nDisallow: /");
});

test("partners page: a partner enquiry form posting to /api/lead, and the referral rules", () => {
  const p = pages.find((x) => x.f === "partners/index.html");
  assert.ok(p, "partners/index.html");
  assert.match(p.html, /action="\/api\/lead"/);
  assert.match(p.html, /name="enquiry_type" value="partner"/);
  assert.match(p.html, /How referrals work/);
  assert.match(pages.find((x) => x.f === "index.html").html, /href="\/partners\/"/);
});

test("no intro video until data/intro-video.json sets one", async () => {
  const video = JSON.parse(await readFile(path.join(ROOT, "data/intro-video.json"), "utf8"));
  if (video.provider) return;
  const home = pages.find((p) => p.f === "index.html").html;
  assert.ok(!/intro-video/.test(home));
});

// -- March 2027 launch (rollout P3) ------------------------------------------------

test("pack prices: annual (best value) beside one-off, all +GST, from the catalogue", () => {
  const all = pages.map((p) => p.html).join("\n");
  for (const p of cat.packs.filter((x) => x.show && x.prices && x.group !== "consultants")) {
    const i = all.indexOf(`data-add-pack="${p.id}"`);
    assert.ok(i > 0, p.id);
    const block = all.slice(all.lastIndexOf('<div class="prices">', i), i);
    assert.match(block, /price-opt price-opt-best[\s\S]*Best value[\s\S]*Annual subscription/, p.id);
    assert.ok(block.includes(`$${p.prices.annual.toLocaleString("en-AU")}<small> +GST a year</small>`), `${p.id} annual`);
    assert.ok(block.includes(`$${p.prices.one_off.toLocaleString("en-AU")}<small> +GST</small>`), `${p.id} one-off`);
    assert.ok(block.indexOf("Annual subscription") < block.indexOf("One-off purchase"), `${p.id}: annual comes first`);
  }
  // Only the purchasable launch wave ("mar-2027") is on show.
  for (const p of cat.packs.filter((x) => x.show)) assert.equal(p.purchasable, true, p.id);
});

test("no founding-offer panel unless data/site-mode.json app_status is presale", async () => {
  const mode = JSON.parse(await readFile(path.join(ROOT, "data/site-mode.json"), "utf8"));
  const shown = pages.filter((p) => p.html.includes("data-founding-panel")).map((p) => p.f).sort();
  assert.deepEqual(shown, mode.app_status === "presale" ? ["index.html", "subscriptions/index.html"] : []);
});

test("no gated product or market is named on a customer page", () => {
  for (const { f, html } of pages) {
    if (f.startsWith("legal/")) continue;
    const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
    assert.equal(text.match(GATED), null, f);
  }
  assert.equal("Core Management System".match(GATED), null, "the FORMS pack name is allowed");
  assert.ok("SiteGuard CORE".match(GATED));
});

test("every pack page: what is in it, project details in, PDFs out, revisions after each 6-monthly review", () => {
  for (const f of ["trade-packs/carpentry/index.html", "builder-packs/index.html", "management-systems/index.html"]) {
    const html = pages.find((p) => p.f === f)?.html;
    assert.ok(html, f);
    assert.match(html, /How a pack works/, f);
    assert.match(html, /Your project details in/, f);
    assert.match(html, /PDFs out/, f);
    assert.match(html, /revised documents pushed to their account after each review/, f);
  }
});

test("FORMS product video slots sit on their pages (placeholders until published)", () => {
  const slot = (f, s) => pages.find((p) => p.f === f)?.html.includes(`data-video-slot="${s}"`);
  assert.ok(slot("trade-packs/index.html", "trade"));
  assert.ok(slot("trade-packs/carpentry/index.html", "trade"));
  assert.ok(slot("builder-packs/index.html", "builder"));
  assert.ok(slot("specialist-packs/index.html", "high-risk"));
  assert.ok(slot("subscriptions/index.html", "subscription"));
});
