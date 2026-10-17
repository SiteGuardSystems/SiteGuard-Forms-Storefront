#!/usr/bin/env node
// Copies the legal sources from SiteGuard-Forms (the one place they are
// written) into content/legal/, so the website pages, the PDFs and the
// disclaimer issued with every delivered set never drift apart.
//
//   node scripts/sync-legal.mjs ../SiteGuard-Forms/app/server/data/legal
import { readdir, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["terms-of-sale.md", "refunds.md", "privacy.md", "disclaimer.md", "consultant-licence.md",
  "terms-of-use.md", "website-terms.md", "checkout-notice.md"];
const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/sync-legal.mjs <path to SiteGuard-Forms/app/server/data/legal>");
  process.exit(2);
}
const have = new Set(await readdir(src));
await mkdir(path.join(ROOT, "content/legal"), { recursive: true });
for (const f of FILES) {
  if (!have.has(f)) { console.error(`missing in source: ${f}`); process.exit(1); }
  await copyFile(path.join(src, f), path.join(ROOT, "content/legal", f));
}
console.log(`copied ${FILES.length} legal files from ${src}`);
