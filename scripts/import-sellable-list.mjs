#!/usr/bin/env node
// Makes data/sellable-now.json (and the pack-level CSV copy in docs/go-live/)
// from Dan's FORMS sellable-now list CSV (SG_FORMS_SELLABLE_NOW_LIST_RevNN_*.csv,
// kept in OneDrive 04_BUSINESS_OPERATIONS; one row per pack and document).
// Nothing is typed by hand: pack ids and document codes are copied from the
// CSV. Titles and prices are not copied (they come from data/catalogue.json
// and the pinned DCR, and this repo is public).
//
//   node scripts/import-sellable-list.mjs <list.csv> [--revision "Rev01, 7 Nov 2026"]
//
// A pack is on sale here when its row says shown_at_launch "Yes" and
// sellable_now_current_ledger "Yes". Held documents (doc_is_held_rev24_entry
// starting "Yes") are never sold singly. Re-run with the next revision of the
// list when the held ledger entries land (81 packs instead of 72).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines in quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = ""; if (row.some((x) => x !== "")) rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}

const REQUIRED = ["pack_id", "pack_name", "group", "trade", "level", "price_one_off_aud_ex_gst", "launch_wave_pricing_rev08",
  "shown_at_launch", "sellable_now_current_ledger", "sellable_once_held_rev24_entries_land", "pack_document_count", "doc_code", "doc_is_held_rev24_entry"];

export function buildList(csvText, { source, revision }) {
  const [header, ...rows] = parseCsv(csvText.replace(/^﻿/, ""));
  for (const h of REQUIRED) if (!header.includes(h)) throw new Error(`the list CSV has no ${h} column`);
  const recs = rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  const packs = new Map();
  const docs = new Set();
  const held = new Set();
  for (const r of recs) {
    if (!r.pack_id || !r.doc_code) throw new Error(`a row without pack_id or doc_code: ${JSON.stringify(r).slice(0, 120)}`);
    if (!packs.has(r.pack_id)) packs.set(r.pack_id, r);
    docs.add(r.doc_code);
    if (/^yes/i.test(r.doc_is_held_rev24_entry)) held.add(r.doc_code);
  }
  const yes = (v) => /^yes$/i.test(v);
  const all = [...packs.values()];
  const now = all.filter((p) => yes(p.shown_at_launch) && yes(p.sellable_now_current_ledger)).map((p) => p.pack_id);
  return {
    json: {
      schema: 1,
      note: "Made by scripts/import-sellable-list.mjs from Dan's FORMS sellable-now list (go-live brief Rev02, 5.2). Never edit by hand: re-run the script on the next revision of the list. It only narrows what data/catalogue.json puts on sale (lib/sellable-list.js).",
      revision,
      source,
      source_sha256: createHash("sha256").update(csvText).digest("hex"),
      packs_sellable_now: now.sort(),
      packs_sellable_once_held_land: all.filter((p) => yes(p.shown_at_launch) && !yes(p.sellable_now_current_ledger) && yes(p.sellable_once_held_rev24_entries_land)).map((p) => p.pack_id).sort(),
      packs_hidden_later_wave: all.filter((p) => !yes(p.shown_at_launch)).map((p) => p.pack_id).sort(),
      held_documents: [...held].sort(),
      documents: [...docs].sort(),
    },
    packCsv: [
      ["pack_id", "pack_name", "group", "trade", "level", "price_one_off_aud_ex_gst", "launch_wave", "shown_at_launch", "sellable_now", "sellable_once_held_entries_land", "documents"].join(","),
      ...all.map((p) => [p.pack_id, p.pack_name, p.group, p.trade, p.level, p.price_one_off_aud_ex_gst.replace(/,/g, ""), p.launch_wave_pricing_rev08,
        p.shown_at_launch, p.sellable_now_current_ledger, p.sellable_once_held_rev24_entries_land, p.pack_document_count]
        .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")),
    ].join("\n") + "\n",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/import-sellable-list.mjs <list.csv> [--revision TEXT]"); process.exit(2); }
  const ri = process.argv.indexOf("--revision");
  const source = path.basename(file);
  const revision = ri > 0 ? process.argv[ri + 1] : (source.match(/Rev\d+/)?.[0] ?? null);
  const { json, packCsv } = buildList(await readFile(file, "utf8"), { source, revision });
  await writeFile(path.join(ROOT, "data/sellable-now.json"), JSON.stringify(json, null, 1) + "\n");
  await mkdir(path.join(ROOT, "docs/go-live"), { recursive: true });
  await writeFile(path.join(ROOT, "docs/go-live", source.replace(/\.csv$/i, ".packs.csv")), packCsv);
  console.log(`data/sellable-now.json: ${json.packs_sellable_now.length} packs on sale now, ${json.packs_sellable_once_held_land.length} once the held entries land, ${json.packs_hidden_later_wave.length} hidden (later wave); ${json.documents.length} documents, ${json.held_documents.length} held`);
}
