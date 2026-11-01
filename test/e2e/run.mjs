#!/usr/bin/env node
// End-to-end check in a real browser (Playwright + the pre-installed
// Chromium): pick a pack, add a single document, open the cart, accept the
// notice, and reach Stripe checkout (a fake Stripe client that redirects to
// the success page). Also checks the enquiry form and the phone layout.
//   npm run test:e2e
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createApp } from "../../lib/create-app.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { console.error("playwright is not installed: npm i -D playwright (browsers are not downloaded; set CHROMIUM_PATH)"); process.exit(2); }

const dir = await mkdtemp(path.join(tmpdir(), "sg-e2e-"));
const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
// Everything listed is put on sale for this test only.
cat.preview = false;
for (const p of cat.packs) { p.sellable = true; p.show = p.listed; }
for (const d of cat.documents) d.sellable = true;
const catPath = path.join(dir, "catalogue.json");
await writeFile(catPath, JSON.stringify(cat));
// The purchase flow is tested with beta off; the beta build is checked separately below.
const openMode = path.join(dir, "site-mode-open.json");
await writeFile(openMode, JSON.stringify({ beta: false }));
const betaMode = path.join(dir, "site-mode-beta.json");
await writeFile(betaMode, JSON.stringify({ beta: true }));
const dist = path.join(dir, "dist");
execFileSync("node", [path.join(ROOT, "scripts/build-site.mjs")], { env: { ...process.env, CATALOGUE_PATH: catPath, DIST_DIR: dist, SITE_MODE_PATH: openMode }, stdio: "inherit" });
const betaDist = path.join(dir, "dist-beta");
execFileSync("node", [path.join(ROOT, "scripts/build-site.mjs")], { env: { ...process.env, CATALOGUE_PATH: catPath, DIST_DIR: betaDist, SITE_MODE_PATH: betaMode }, stdio: "inherit" });

const calls = [];
let port;
const stripe = {
  checkout: { sessions: { create: async (p) => { calls.push(p); return { id: "cs_test_1", url: `http://127.0.0.1:${port}/order/success/` }; } } },
  webhooks: { constructEvent: (b) => JSON.parse(b) },
};
const app = createApp({ catalogPath: catPath, varDir: path.join(dir, "var"), publicDir: dist, stripe, stripeTestMode: true,
  publicOrigin: "http://127.0.0.1", mailer: { configured: false }, leadAllowedOrigins: [] });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
port = server.address().port;
const base = `http://127.0.0.1:${port}`;

import { existsSync } from "node:fs";
const exe = process.env.CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${base}/trade-packs/carpentry/`);
  await page.locator('[data-add-pack="subcontractor:CARP:domestic"]').click();
  await page.locator(".toast").waitFor();
  assert.match(await page.locator("[data-cart-count]").first().textContent(), /\(1\)/);

  await page.goto(`${base}/documents/`);
  await page.fill('input[name="q"]', "carpentry");
  await page.locator("[data-add-doc]").first().click();
  assert.match(await page.locator("[data-cart-count]").first().textContent(), /\(2\)/);

  await page.goto(`${base}/cart/`);
  assert.equal(await page.locator(".cart-table tbody tr").count(), 2);
  await page.click('button[type="submit"]');
  assert.match(await page.locator("[data-status]").textContent(), /Tick the box/);
  await page.check('input[name="accept"]');
  await page.fill('input[name="siteName"]', "Riverside Apartments Stage 2");
  await Promise.all([page.waitForURL(`${base}/order/success/`), page.click('button[type="submit"]')]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.siteName, "Riverside Apartments Stage 2", "the cart page sends the optional site name");
  assert.equal(calls[0].line_items.length, 2);
  assert.equal(calls[0].line_items[0].price_data.unit_amount, cat.packs.find((p) => p.id === "subcontractor:CARP:domestic").prices.one_off * 100);
  assert.match(await page.locator("[data-cart-count]").first().textContent(), /\(0\)/);

  // A pack outside the purchasable launch waves (Pricing Rev06 "later") can't be bought,
  // even when this test puts it on show.
  const later = cat.packs.find((p) => p.listed && p.purchasable === false && p.group === "specialist-packs" && !p.trade && p.prices?.one_off);
  if (later) {
    await page.goto(`${base}/specialist-packs/`);
    assert.equal(await page.locator(`[data-add-pack="${later.id}"]`).getAttribute("aria-disabled"), "true", `${later.id} is disabled`);
    assert.ok(await page.locator(`#${later.id.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`).getByText("Not yet available to buy.").isVisible());
    const st = (await fetch(`${base}/api/checkout`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart: [{ packageId: later.id }], acceptedTerms: true }) })).status;
    assert.equal(st, 409, "the server refuses a later-wave pack");
  }

  // Subscribe links go to the FORMS app signup with the pack and cadence.
  await page.goto(`${base}/trade-packs/carpentry/`);
  const href = await page.locator('a:has-text("Subscribe yearly")').first().getAttribute("href");
  assert.match(href, /\/signup\?pack=subcontractor%3ACARP%3Adomestic&cadence=annual/);

  // Enquiry form
  await page.goto(`${base}/contact/`);
  await page.fill('input[name="name"]', "Test Person");
  await page.fill('input[name="email"]', "test@example.com");
  await page.fill('textarea[name="need"]', "A custom SWMS");
  await page.click('button[type="submit"]');
  await page.locator(".form-status.ok").waitFor();

  // Phone width: no sideways scroll on the main pages.
  const phone = await browser.newPage({ viewport: { width: 360, height: 780 } });
  for (const p of ["/", "/trade-packs/", "/trade-packs/carpentry/", "/builder-packs/", "/subscriptions/", "/documents/", "/cart/", "/legal/privacy/"]) {
    await phone.goto(base + p);
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${p} scrolls sideways by ${over}px at 360px`);
  }
  await phone.goto(`${base}/`);
  await phone.click(".menu-toggle");
  assert.ok(await phone.locator("#site-nav").isVisible());

  // Beta build: banner shown, Add to cart disabled, and the server refuses checkout.
  const betaApp = createApp({ catalogPath: catPath, varDir: path.join(dir, "var-beta"), publicDir: betaDist, stripe, stripeTestMode: true,
    publicOrigin: "http://127.0.0.1", mailer: { configured: false }, leadAllowedOrigins: [], beta: true });
  const betaServer = betaApp.listen(0);
  await new Promise((r) => betaServer.once("listening", r));
  const betaBase = `http://127.0.0.1:${betaServer.address().port}`;
  try {
    const bp = await browser.newPage();
    bp.on("pageerror", (e) => errors.push(e.message));
    await bp.goto(`${betaBase}/trade-packs/carpentry/`);
    assert.ok(await bp.locator(".beta-bar").isVisible(), "beta banner visible");
    assert.equal(await bp.locator('[data-add-pack="subcontractor:CARP:domestic"]').getAttribute("aria-disabled"), "true");
    const before = calls.length;
    const res = await bp.evaluate(async () => (await fetch("/api/checkout", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cart: [{ packageId: "subcontractor:CARP:domestic" }], acceptedTerms: true }) })).status);
    assert.equal(res, 503);
    assert.equal(calls.length, before, "beta never reaches Stripe");
  } finally {
    await new Promise((r) => betaServer.close(r));
  }

  assert.deepEqual(errors, [], "browser console errors");
  console.log("e2e: all checks passed");
} finally {
  await browser.close();
  server.close();
}
