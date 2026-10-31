#!/usr/bin/env node
// scripts/dcr-check.mjs -- the CI `dcr-check` (T07; DCR single-truth brief §2.7;
// the Storefront twin of SiteGuard-Forms server/dcr-check.ts, against the PUBLIC
// page-A extract this public repo pins). Read-only: no network, no secrets.
//
// Fails when (brief 2.7):
//   hash            the vendored extract doesn't hash to dcr.lock (or its sidecar),
//                   or names another revision or source dcr.json
//   unknown_code    a document code in data/, content/ or the site's own code and
//                   copy is not a public page-A code in the pinned extract (full
//                   "SG-F-" codes, and bare library codes such as SAF-SWMS-CARP-001).
//                   The extract holds no reserved, page-B or internal row, so a
//                   reserved code shown anywhere public fails here.
//   not_eligible    catalogue.json shows or sells a retired or superseded code
//   title_mismatch  a title next to a code differs from the DCR title
//   stamp_mismatch  catalogue.json's dcr_revision / dcr_sha256 differ from dcr.lock
//   not_stamped     catalogue.json carries no DCR stamp
//   generated_drift catalogue.json breaks a rule its generator always follows, i.e.
//                   it was edited by hand (scripts/lib/dcr.mjs checkGenerated)
// Warning only: retired_reference (a retired code neither shown nor sold, or
// named outside the catalogue).
// Not checked: whether dcr.lock is more than one revision behind the latest
// published one (a warning in brief 2.7). This check runs with no network, so it
// can't see siteguard-dcr; the lock moves by the bump PR (README, "DCR").
//
// Justified exceptions live in dcr.allowlist.json, each with a reason. An entry
// that no longer matches a finding fails the check (a stale entry would hide a
// regression), and the allow-list must name the revision dcr.lock pins.
//
//   npm run dcr-check            # report; exit 1 on any error not allow-listed
//   npm run dcr-check -- --json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCatalogue, checkGenerated, defaultPaths, fullCode, isEligible, loadPinned, normTitle, rev2 } from "./lib/dcr.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOGUE_REL = "data/catalogue.json";

/** Where the check looks: the data, the copy, and the site's own code. */
export const SCAN_ROOTS = ["data/", "content/", "scripts/", "lib/", "public/", "deploy/", "server.js", "README.md", "HARDENING.md"];
export const SCAN_EXTENSIONS = [".json", ".md", ".js", ".mjs", ".cjs", ".html", ".css", ".txt", ".sh", ".service"];

/** A full product code, or a bare library code (the catalogue's form). A bare match
 *  only counts when its first part is a family prefix the extract uses. */
export const FULL_RE = /(?<![A-Za-z0-9-])(SG-F-[A-Z]{2,5}(?:-[A-Z0-9]{2,6}){1,3}-\d{2,3})(?![A-Za-z0-9])/g;
export const BARE_RE = /(?<![A-Za-z0-9-])([A-Z]{2,5}(?:-[A-Z0-9]{2,6}){1,3}-\d{3})(?![A-Za-z0-9])/g;

const CODE_KEYS = ["code", "dcrn", "document_code", "documentCode"];
const TITLE_KEYS = ["title", "document_title", "documentTitle"];

function listFiles(root) {
  let rel;
  try {
    rel = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    rel = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "dist", "vendor", "var"].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else rel.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
  }
  return rel
    .filter((f) => SCAN_ROOTS.some((r) => (r.endsWith("/") ? f.startsWith(r) : f === r)))
    .filter((f) => SCAN_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .filter((f) => existsSync(path.join(root, f)))
    .sort();
}

/** Run every check. Never throws for a check failure: it reports findings. */
export function runDcrCheck({ root = ROOT, lockPath, vendorDir, allowlistPath } = {}) {
  ({ lockPath, vendorDir } = { ...defaultPaths(root), ...(lockPath ? { lockPath } : {}), ...(vendorDir ? { vendorDir } : {}) });
  allowlistPath ??= path.join(root, "dcr.allowlist.json");
  const findings = [];
  const add = (kind, severity, file, code, message) => findings.push({ kind, severity, file, code, message });

  // ---- 1. the pin ---------------------------------------------------------------
  let pinned = null;
  try { pinned = loadPinned(root, { lockPath, vendorDir }); } catch (e) { add("hash", "error", "dcr.lock", null, e.message); }
  const lock = pinned?.lock ?? null;

  // ---- the allow-list -------------------------------------------------------------
  let allow = { dcr_revision: lock?.revision ?? -1, excluded_paths: [], exceptions: [] };
  if (existsSync(allowlistPath)) {
    try {
      const a = JSON.parse(readFileSync(allowlistPath, "utf8"));
      allow = { dcr_revision: Number(a.dcr_revision), excluded_paths: a.excluded_paths ?? [], exceptions: a.exceptions ?? [] };
      if (lock && allow.dcr_revision !== lock.revision) {
        add("allowlist_invalid", "error", "dcr.allowlist.json", null, `dcr.allowlist.json is for Rev${rev2(allow.dcr_revision)}, dcr.lock pins Rev${rev2(lock.revision)}: re-check every entry, then set dcr_revision`);
      }
      for (const e of allow.excluded_paths) {
        if (!(e.path_prefix || e.path_suffix) || !e.why?.trim()) add("allowlist_invalid", "error", "dcr.allowlist.json", null, `excluded_paths entry needs path_prefix or path_suffix and a why: ${JSON.stringify(e)}`);
      }
      for (const e of allow.exceptions) {
        if (!e.kind || !e.file || !Array.isArray(e.codes) || !e.codes.length || !e.why?.trim()) add("allowlist_invalid", "error", "dcr.allowlist.json", null, `exception needs kind, file, codes and a why: ${JSON.stringify(e).slice(0, 200)}`);
      }
    } catch (e) {
      add("allowlist_invalid", "error", "dcr.allowlist.json", null, `dcr.allowlist.json does not parse: ${e.message}`);
    }
  }
  const excluded = (f) => allow.excluded_paths.some((e) => (e.path_prefix && f.startsWith(e.path_prefix)) || (e.path_suffix && f.endsWith(e.path_suffix)));

  // ---- 2-5. the repo's data, copy and code ---------------------------------------------
  const files = listFiles(root).filter((f) => !excluded(f));
  if (pinned) {
    const { dcr } = pinned;
    const R = `DCR Rev${rev2(dcr.revision)}`;
    const prefixes = new Set(dcr.rows.map((r) => r.product_code.slice(5).split("-")[0]));
    const seen = new Set();
    const once = (k) => (seen.has(k) ? false : (seen.add(k), true));
    const ref = (file, raw) => {
      const row = dcr.byCode(raw);
      if (!row) { if (once(`u|${file}|${raw}`)) add("unknown_code", "error", file, fullCode(raw), `${raw} is not a public page-A code in ${R}`); }
      else if (!isEligible(row) && once(`r|${file}|${raw}`)) {
        add("retired_reference", "warning", file, row.product_code, `${raw} is named here but is ${row.lifecycle_status} in ${R}${row.retired_to ? ` (kept code ${row.retired_to})` : ""}`);
      }
    };
    for (const file of files) {
      const full = path.join(root, file);
      if (file === CATALOGUE_REL) {
        let cat;
        try { cat = JSON.parse(readFileSync(full, "utf8")); } catch (e) { add("unknown_code", "error", file, null, `does not parse: ${e.message}`); continue; }
        for (const f of checkCatalogue(cat, pinned)) findings.push({ ...f, file });
        for (const f of checkGenerated(cat)) findings.push({ ...f, file });
        continue;
      }
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(FULL_RE)) ref(file, m[1]);
      for (const m of text.matchAll(BARE_RE)) if (prefixes.has(m[1].split("-")[0])) ref(file, m[1]);
      if (path.extname(file) !== ".json") continue;
      let data;
      try { data = JSON.parse(text); } catch { continue; }
      const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (!o || typeof o !== "object") return;
        const ck = CODE_KEYS.find((k) => typeof o[k] === "string");
        const tk = TITLE_KEYS.find((k) => typeof o[k] === "string");
        if (ck && tk) {
          const row = dcr.byCode(o[ck]);
          if (row?.title && normTitle(o[tk]) !== normTitle(row.title) && once(`t|${file}|${row.product_code}`)) {
            add("title_mismatch", "error", file, row.product_code, `${o[ck]}: ${file} says "${o[tk]}", ${R} says "${row.title}"`);
          }
        }
        Object.values(o).forEach(walk);
      };
      walk(data);
    }
  }

  // ---- apply the allow-list ---------------------------------------------------------
  const used = new Set();
  for (const f of findings) {
    const ex = allow.exceptions.find((e) => e.kind === f.kind && e.file === f.file && f.code != null && e.codes.includes(f.code));
    if (ex) { f.allowedBy = ex.why; used.add(`${ex.kind}|${ex.file}|${f.code}`); }
  }
  for (const e of allow.exceptions) for (const c of e.codes ?? []) {
    if (!used.has(`${e.kind}|${e.file}|${c}`)) add("allowlist_stale", "error", "dcr.allowlist.json", c, `allow-list entry ${e.kind} ${e.file} ${c} no longer matches a finding: remove it`);
  }
  const open = findings.filter((f) => !f.allowedBy);
  const errors = open.filter((f) => f.severity === "error");
  return {
    ok: errors.length === 0,
    lock: lock ? { revision: lock.revision, sha256: lock.sha256, source_dcr_sha256: lock.source_dcr_sha256 } : null,
    extract: { sha256: pinned?.dcr.sha256 ?? null, revision: pinned?.dcr.revision ?? null, rows: pinned?.dcr.rows.length ?? 0 },
    filesScanned: files.length,
    findings,
    errors,
    warnings: open.filter((f) => f.severity === "warning"),
    allowed: findings.filter((f) => f.allowedBy),
  };
}

const countBy = (fs) => {
  const m = new Map();
  for (const f of fs) m.set(f.kind, (m.get(f.kind) ?? 0) + 1);
  return [...m].sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none";
};

export function formatReport(r) {
  const L = [];
  L.push(`dcr-check: dcr.lock Rev${r.lock ? rev2(r.lock.revision) : "?"} public extract sha256 ${r.lock?.sha256 ?? "?"} (from dcr.json ${r.lock?.source_dcr_sha256 ?? "?"})`);
  L.push(`  extract: sha256 ${r.extract.sha256 ?? "?"}, ${r.extract.rows} public page-A rows`);
  L.push(`  files scanned: ${r.filesScanned}`);
  L.push(`  findings: ${r.findings.length} (${countBy(r.findings)})`);
  L.push(`  allowed by dcr.allowlist.json: ${r.allowed.length} (${countBy(r.allowed)})`);
  for (const [label, list] of [["ERROR", r.errors], ["WARNING", r.warnings]]) {
    for (const f of list) L.push(`${label} [${f.kind}] ${f.file ?? ""}${f.code ? ` ${f.code}` : ""}: ${f.message}`);
  }
  L.push(r.ok ? `dcr-check: PASS (${r.warnings.length} warning(s))` : `dcr-check: FAIL (${r.errors.length} error(s), ${r.warnings.length} warning(s))`);
  return L.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runDcrCheck();
  console.log(process.argv.includes("--json") ? JSON.stringify(r, null, 1) : formatReport(r));
  process.exitCode = r.ok ? 0 : 1;
}
