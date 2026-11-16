// FORMS queue S12: render the share cards (1200x630 PNG) into public/assets/og/.
//   npm run share-cards
// Run after a catalogue change adds a trade or range, then commit the PNGs.
// Uses the Playwright Chromium the browser tests already install.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { cardsFor, cardHtml, CARD_W, CARD_H, CARD_DIR, DEFAULT_CARD } from "./lib/share-cards.mjs";
import { shopModel } from "./lib/shop.mjs";
import { loadSellableList, applySellableList } from "../lib/sellable-list.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGUE = process.env.CATALOGUE_PATH ? path.resolve(process.env.CATALOGUE_PATH) : path.join(ROOT, "data/catalogue.json");
const LIST = process.env.SELLABLE_LIST_PATH ? path.resolve(process.env.SELLABLE_LIST_PATH) : path.join(ROOT, "data/sellable-now.json");

const cat = applySellableList(JSON.parse(await readFile(CATALOGUE, "utf8")), loadSellableList(LIST));
const cards = [DEFAULT_CARD, ...cardsFor(cat, shopModel(cat)).values()];
const out = path.join(ROOT, "public", CARD_DIR);
await mkdir(out, { recursive: true });
const assetsUrl = pathToFileURL(path.join(ROOT, "public/assets")).href;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: CARD_W, height: CARD_H } });
  // Loaded from a file so the card can use the site's own fonts and shield.
  const tmp = await mkdtemp(path.join(tmpdir(), "sg-cards-"));
  const htmlFile = path.join(tmp, "card.html");
  for (const c of cards) {
    await writeFile(htmlFile, cardHtml(c, { assetsUrl }));
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await writeFile(path.join(out, c.file), await page.screenshot({ type: "png" }));
    console.log(`${CARD_DIR}/${c.file}  ${c.title}`);
  }
  await rm(tmp, { recursive: true, force: true });
} finally {
  await browser.close();
}
console.log(`${cards.length} share cards written to public/${CARD_DIR}/`);
