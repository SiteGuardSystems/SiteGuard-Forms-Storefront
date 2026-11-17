// Fill data/pack-videos.json from the YouTube upload sheet (SG-E-EDU-YT-003
// .csv in OneDrive 10_EDUCATION\05_YOUTUBE_PREP): every row with a doc and a
// youtube_url sets that video's youtube_url, and its upload_date (today, or
// --date YYYY-MM-DD) if it has none yet. Rows without a link are left alone.
//
//   node scripts/fill-pack-videos.mjs <sheet.csv> [--date 2026-11-16] [--dry-run]
//
// Then rebuild (npm run build:production) and restart the storefront so its
// CSP opens youtube-nocookie.com and i.ytimg.com.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { youtubeId } from "./lib/video.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal RFC 4180 CSV parser (quoted fields, "" escapes, newlines in quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ""));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** Apply the sheet's links to the pack-videos data. Returns { data, changed, problems }. */
export function fill(data, sheet, date) {
  const problems = [];
  const changed = [];
  const byDoc = new Map((data.videos ?? []).map((v) => [v.doc, v]));
  for (const r of sheet) {
    if (!r.youtube_url) continue;
    const v = byDoc.get(r.doc);
    if (!v) { problems.push(`${r.doc}: not in data/pack-videos.json`); continue; }
    if (!youtubeId(r.youtube_url)) { problems.push(`${r.doc}: not a YouTube video link: ${r.youtube_url}`); continue; }
    if (v.youtube_url === r.youtube_url && v.upload_date) continue;
    v.youtube_url = r.youtube_url;
    if (!v.upload_date) v.upload_date = date;
    changed.push(r.doc);
  }
  return { data, changed, problems };
}

async function main() {
  const args = process.argv.slice(2);
  const csv = args.find((a) => !a.startsWith("--") && a !== args[args.indexOf("--date") + 1]);
  if (!csv) { console.error("usage: node scripts/fill-pack-videos.mjs <sheet.csv> [--date YYYY-MM-DD] [--dry-run]"); process.exit(2); }
  const di = args.indexOf("--date");
  const date = di >= 0 ? args[di + 1] : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) { console.error("--date must be YYYY-MM-DD"); process.exit(2); }
  const file = path.join(ROOT, "data", "pack-videos.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  const { changed, problems } = fill(data, parseCsv(await readFile(csv, "utf8")), date);
  for (const p of problems) console.warn(`not filled: ${p}`);
  console.log(`${changed.length} video(s) filled${changed.length ? `: ${changed.join(", ")}` : ""}.`);
  if (problems.length) process.exitCode = 1;
  if (!args.includes("--dry-run") && changed.length) await writeFile(file, JSON.stringify(data, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
