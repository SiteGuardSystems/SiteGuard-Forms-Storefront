// Snapshot of the built site (WP-S8): one sha256 per file in dist/, after
// taking out what changes on every build (CRLF from a Windows checkout, the
// build time in build-info.json, DTSTAMP in the .ics files and the footer's
// copyright year). test/shop-snapshot.test.js builds the site and compares it
// with test/fixtures/dist-snapshot.json, so moving the shop and cart code into
// scripts/lib/shop.mjs, cart.mjs and cart-browser.js provably changed nothing.
//
//   node test/dist-snapshot.mjs <dist> > test/fixtures/dist-snapshot.json
// Only regenerate the fixture for an intended change to the built output.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT = /\.(html|js|css|json|xml|txt|ics)$/;

export function normalise(rel, buf) {
  if (!TEXT.test(rel)) return buf;
  let s = buf.toString("utf8").replace(/\r\n/g, "\n");
  if (rel === "build-info.json") s = s.replace(/"built_at": "[^"]*"/, '"built_at": ""');
  if (rel.endsWith(".ics")) s = s.replace(/^DTSTAMP:.*$/gm, "DTSTAMP:");
  if (rel.endsWith(".html")) s = s.replace(/© \d{4} SiteGuard/g, "© YEAR SiteGuard");
  return Buffer.from(s, "utf8");
}

export async function snapshot(dist) {
  const out = {};
  async function walk(dir) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const rel = path.relative(dist, p).split(path.sep).join("/");
        out[rel] = createHash("sha256").update(normalise(rel, await readFile(p))).digest("hex");
      }
    }
  }
  await walk(dist);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = process.argv[2];
  if (!dist) { console.error("usage: node test/dist-snapshot.mjs <dist>"); process.exit(2); }
  process.stdout.write(JSON.stringify(await snapshot(path.resolve(dist)), null, 1) + "\n");
}
