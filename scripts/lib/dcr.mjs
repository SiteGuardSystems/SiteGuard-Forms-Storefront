// scripts/lib/dcr.mjs -- the pinned PUBLIC DCR extract (T07; DCR single-truth brief §2.5-2.7).
//
// This repo is public, so it never holds the full DCR snapshot (Dan, 31 Oct
// 2026). dcr.lock pins siteguard-dcr's public page-A extract,
// public/revNN/dcr-public.json, by sha256, and records the sha256 of the full
// releases/revNN/dcr.json it was made from. The extract is vendored under
// vendor/siteguard-dcr/public/revNN (marked -text in .gitattributes). No deploy
// key, no network, no proprietary client: this file is the whole reader.
//
// The extract holds only page A, external, non-reserved rows with whitelisted
// fields (product_code, title, family, current_rev, lifecycle_status,
// retired_to, package_family, bundle). So a code that isn't in it is either
// unknown to the DCR or not public; either way the storefront must not show it.
//
// READ-ONLY. Used by scripts/build-site.mjs (the build fails when the extract
// doesn't verify, or when the catalogue shows or sells a code the extract
// doesn't allow) and by scripts/dcr-check.mjs (CI).
//
// The DCR decides which codes may be SHOWN. It never decides what is SOLD:
// prices and `sellable` still come from catalogue.json, i.e. Hseq-Dev
// packages.py via build_catalogue.py.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PUBLIC_SCHEMA_VERSION = "public-1.0";

/**
 * Titles: "warn now, fail later". A catalogue title that differs from the DCR
 * title is a warning until Hseq-Dev build_catalogue.py takes titles from the
 * DCR (in flight). Then set this to "fail". DCR_TITLES=fail|warn overrides it.
 */
export const TITLE_POLICY = "warn";

export function titlePolicy(env = process.env) {
  const v = (env.DCR_TITLES ?? "").trim().toLowerCase();
  return v === "fail" || v === "warn" ? v : TITLE_POLICY;
}

export const rev2 = (n) => String(n).padStart(2, "0");
const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Bytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function defaultPaths(root) {
  return {
    lockPath: process.env.DCR_LOCK_PATH ? path.resolve(process.env.DCR_LOCK_PATH) : path.join(root, "dcr.lock"),
    vendorDir: process.env.DCR_VENDOR_DIR ? path.resolve(process.env.DCR_VENDOR_DIR) : path.join(root, "vendor", "siteguard-dcr"),
  };
}

export function readLock(lockPath) {
  if (!existsSync(lockPath)) throw new Error(`${lockPath} not found`);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const revision = Number(lock.revision);
  if (!Number.isInteger(revision)) throw new Error(`dcr.lock: revision ${JSON.stringify(lock.revision)} is not a whole number`);
  for (const k of ["sha256", "source_dcr_sha256"]) {
    if (!HEX64.test(String(lock[k] ?? "").toLowerCase())) throw new Error(`dcr.lock: ${k} must be 64 hex characters`);
  }
  if (typeof lock.path !== "string" || !lock.path) throw new Error("dcr.lock: path is required");
  return { ...lock, revision, sha256: lock.sha256.toLowerCase(), source_dcr_sha256: lock.source_dcr_sha256.toLowerCase() };
}

/** Catalogue codes carry no "SG-F-"; DCR product codes do. */
export function fullCode(code) {
  const c = String(code).trim().toUpperCase();
  return c.startsWith("SG-F-") ? c : `SG-F-${c}`;
}

/** Title comparison ignores case, spacing and dash / quote typography only (as Forms and Hseq-Dev do). */
export function normTitle(t) {
  return String(t)
    .normalize("NFKC")
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const lower = (s) => String(s ?? "").trim().toLowerCase();

/** Live in the public extract: not Retired / Superseded, and no kept code. Every row is page A and not reserved. */
export function isEligible(row) {
  return !!row && !["retired", "superseded"].includes(lower(row.lifecycle_status)) && !row.retired_to;
}

/** The verified extract, read-only. */
export class PublicDcr {
  constructor(extract, sha256) {
    this.meta = Object.freeze({ ...extract.meta });
    this.rows = Object.freeze(extract.rows.map((r) => Object.freeze({ ...r })));
    this.sha256 = sha256;
    this.byCodeMap = new Map(this.rows.map((r) => [r.product_code.toUpperCase(), r]));
    Object.freeze(this);
  }
  get revision() { return this.meta.revision; }
  get sourceSha256() { return this.meta.source_dcr_sha256; }
  byCode(code) { return code ? this.byCodeMap.get(fullCode(code)) : undefined; }
  eligible(code) { return isEligible(this.byCode(code)); }
}

/**
 * Load and verify the pinned extract: its bytes hash to dcr.lock's sha256 and
 * to its dcr-public.sha256 sidecar; its meta names the lock's revision and
 * source dcr.json sha256. Throws on any mismatch; the caller fails the build.
 */
export function loadPinned(root, opts = {}) {
  const { lockPath, vendorDir } = { ...defaultPaths(root), ...opts };
  const lock = readLock(lockPath);
  const file = path.join(vendorDir, lock.path);
  if (!existsSync(file)) throw new Error(`dcr.lock pins ${lock.path}, but it is not vendored`);
  const bytes = readFileSync(file);
  const got = sha256Bytes(bytes);
  if (got !== lock.sha256) throw new Error(`${lock.path}: sha256 ${got} does not match dcr.lock ${lock.sha256}`);
  const sidecar = path.join(path.dirname(file), "dcr-public.sha256");
  if (existsSync(sidecar)) {
    const recorded = lower(readFileSync(sidecar, "utf8").split(/\s+/)[0]);
    if (recorded !== got) throw new Error(`${lock.path}: sha256 ${got} does not match its dcr-public.sha256 ${recorded}`);
  }
  let extract;
  try { extract = JSON.parse(bytes.toString("utf8")); } catch (e) { throw new Error(`${lock.path}: not valid JSON: ${e.message}`); }
  const m = extract?.meta ?? {};
  if (m.schema_version !== PUBLIC_SCHEMA_VERSION) throw new Error(`${lock.path}: schema_version ${JSON.stringify(m.schema_version)}, expected ${PUBLIC_SCHEMA_VERSION}`);
  if (m.revision !== lock.revision) throw new Error(`${lock.path} is Rev${m.revision}, dcr.lock pins Rev${lock.revision}`);
  if (lower(m.source_dcr_sha256) !== lock.source_dcr_sha256) throw new Error(`${lock.path} was made from dcr.json ${m.source_dcr_sha256}, dcr.lock says ${lock.source_dcr_sha256}`);
  if (!Array.isArray(extract.rows) || extract.rows.length !== m.row_count) throw new Error(`${lock.path}: row_count ${m.row_count} does not match ${extract.rows?.length} rows`);
  return { dcr: new PublicDcr(extract, got), lock };
}

/**
 * Every document code the storefront shows or sells, by the same rules the
 * build and the checkout use: documents on the single-documents page (all in a
 * preview, else the sellable ones), every member of a pack the build shows
 * (show && prices), and every member of a pack the checkout accepts
 * (listed && sellable, lib/create-app.js).
 */
export function shownCodes(cat) {
  const shown = new Map(); // code -> where
  const note = (c, where) => { if (!shown.has(c)) shown.set(c, where); };
  for (const d of cat.documents ?? []) if (cat.preview || d.sellable) note(d.code, "single documents page");
  for (const p of cat.packs ?? []) {
    if ((p.show && p.prices) || (p.listed && p.sellable)) for (const c of p.documents ?? []) note(c, `pack ${p.id}`);
  }
  return shown;
}

/**
 * Checks one catalogue against the pinned extract. Returns findings
 * { kind, severity: "error"|"warning", code, message }. Kinds:
 *   unknown_code      a code isn't in the public extract (unknown, or not public)   error
 *   not_eligible      a code shown or sold is retired or superseded                  error
 *   retired_reference a code neither shown nor sold is retired or superseded         warning
 *   title_mismatch    a document title differs from the DCR title                   titlePolicy()
 *   stamp_mismatch    dcr_revision / dcr_sha256 differ from dcr.lock, or only one is present  error
 *   not_stamped       no dcr_revision / dcr_sha256 stamp (Hseq-Dev PR #41 adds it)              warning
 * The catalogue stamp names the FULL release (dcr_sha256 = dcr.lock source_dcr_sha256).
 */
export function checkCatalogue(cat, { dcr, lock }, { titles = titlePolicy() } = {}) {
  const findings = [];
  const add = (kind, severity, code, message) => findings.push({ kind, severity, code, message });
  const R = `DCR Rev${rev2(dcr.revision)}`;

  // Stamp
  const nested = cat.dcr && typeof cat.dcr === "object" ? cat.dcr : {};
  const sRev = cat.dcr_revision ?? nested.revision;
  const sSha = cat.dcr_sha256 ?? nested.sha256;
  if (sRev === undefined && sSha === undefined) {
    add("not_stamped", "warning", null, `catalogue.json carries no dcr_revision / dcr_sha256 stamp (Hseq-Dev build_catalogue.py adds it, PR #41); dcr.lock pins Rev${rev2(lock.revision)}`);
  } else {
    if (sRev === undefined || sSha === undefined) add("stamp_mismatch", "error", null, "catalogue.json stamp is incomplete: it needs both dcr_revision and dcr_sha256");
    if (sRev !== undefined && Number(sRev) !== lock.revision) add("stamp_mismatch", "error", null, `catalogue.json is stamped DCR Rev${sRev}; dcr.lock pins Rev${rev2(lock.revision)}`);
    if (sSha !== undefined && lower(sSha) !== lock.source_dcr_sha256) add("stamp_mismatch", "error", null, `catalogue.json is stamped dcr.json sha256 ${sSha}; dcr.lock pins ${lock.source_dcr_sha256}`);
  }

  // Codes
  const shown = shownCodes(cat);
  const all = new Set([...(cat.documents ?? []).map((d) => d.code), ...(cat.packs ?? []).flatMap((p) => p.documents ?? [])]);
  for (const c of [...all].sort()) {
    const row = dcr.byCode(c);
    const where = shown.has(c) ? ` (${shown.get(c)})` : "";
    if (!row) {
      add("unknown_code", "error", fullCode(c), `${c} is not a public page-A code in ${R}${where}`);
    } else if (!isEligible(row)) {
      const msg = `${c} is ${row.lifecycle_status ?? "not live"} in ${R}${row.retired_to ? `; kept code ${row.retired_to}` : ""}`;
      if (shown.has(c)) add("not_eligible", "error", row.product_code, `${msg}: refusing to show or sell it${where}`);
      else add("retired_reference", "warning", row.product_code, `${msg} (in catalogue.json, neither shown nor sold)`);
    }
  }

  // Titles
  for (const d of cat.documents ?? []) {
    const row = dcr.byCode(d.code);
    if (row?.title && typeof d.title === "string" && normTitle(d.title) !== normTitle(row.title)) {
      add("title_mismatch", titles === "fail" ? "error" : "warning", row.product_code, `${d.code}: catalogue says "${d.title}", ${R} says "${row.title}"`);
    }
  }
  return findings;
}
