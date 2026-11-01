// T07: the pinned public DCR extract, the build's DCR gate and the CI dcr-check.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCatalogue, checkGenerated, fullCode, isEligible, loadPinned, normTitle, readLock, shownCodes } from "../scripts/lib/dcr.mjs";
import { runDcrCheck } from "../scripts/dcr-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = readLock(path.join(ROOT, "dcr.lock"));
const pinned = loadPinned(ROOT);
const { dcr } = pinned;
const bare = (row) => row.product_code.replace(/^SG-F-/, "");

// Real rows of the pinned extract; a code that isn't public is synthetic.
const live = dcr.rows.find((r) => isEligible(r));
const retired = dcr.rows.find((r) => r.retired_to);
const NOT_PUBLIC = "TST-FRM-GEN-999";

function catalogue(over = {}) {
  return {
    schema: 1, preview: false, dcr_revision: LOCK.revision, dcr_sha256: LOCK.source_dcr_sha256,
    packs: [{ id: "p1", listed: true, show: true, sellable: true, prices: { one_off: 1 }, documents: [bare(live)] }],
    documents: [{ code: bare(live), title: live.title, sellable: true }],
    ...over,
  };
}
const kinds = (fs, sev) => fs.filter((f) => !sev || f.severity === sev).map((f) => f.kind).sort();

describe("pinned public extract (dcr.lock)", () => {
  test("Rev23 public extract loads and verifies against dcr.lock", () => {
    assert.equal(LOCK.revision, 23);
    assert.equal(LOCK.sha256, "ee1287fab6a10715edd66cc9e8088a114fea59843db7baec8e74b289a6f8e9cf");
    assert.equal(LOCK.source_dcr_sha256, "8a8db29c7753ded334f8170bb20b1029fe94e414667e027bc10ffc0e0670a7af");
    assert.equal(dcr.revision, 23);
    assert.equal(dcr.sourceSha256, LOCK.source_dcr_sha256);
    assert.ok(live && retired, "Rev23 has live and retired public rows to test with");
  });

  test("the extract holds only whitelisted fields", () => {
    const allowed = ["bundle", "current_rev", "family", "lifecycle_status", "package_family", "product_code", "retired_to", "title"];
    for (const r of dcr.rows) assert.deepEqual(Object.keys(r).sort(), allowed);
    assert.deepEqual(Object.keys(dcr.meta).sort(), ["issued_date", "revision", "row_count", "schema_version", "source_dcr_sha256"]);
  });

  test("a tampered extract or a wrong lock fails to load", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcr-t07-"));
    try {
      await cp(path.join(ROOT, "vendor/siteguard-dcr"), path.join(dir, "v"), { recursive: true });
      const json = path.join(dir, "v", LOCK.path);
      await writeFile(json, (await readFile(json, "utf8")).replace(live.title, `${live.title}.`));
      assert.throws(() => loadPinned(ROOT, { vendorDir: path.join(dir, "v") }), /does not match dcr\.lock/);
      const lockPath = path.join(dir, "dcr.lock");
      await writeFile(lockPath, JSON.stringify({ ...LOCK, sha256: "0".repeat(64) }));
      assert.throws(() => loadPinned(ROOT, { lockPath }), /does not match dcr\.lock/);
      await writeFile(lockPath, JSON.stringify({ ...LOCK, source_dcr_sha256: "0".repeat(64) }));
      assert.throws(() => loadPinned(ROOT, { lockPath }), /was made from dcr\.json/);
      await writeFile(lockPath, JSON.stringify({ ...LOCK, revision: 22 }));
      assert.throws(() => loadPinned(ROOT, { lockPath }), /dcr\.lock pins Rev22/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("catalogue against the DCR", () => {
  test("today's shape passes: known, live, matching title, stamped", () => {
    assert.deepEqual(checkCatalogue(catalogue(), pinned), []);
  });

  test("a retired code shown or sold fails; neither shown nor sold warns", () => {
    const c = bare(retired);
    assert.deepEqual(kinds(checkCatalogue(catalogue({ packs: [{ id: "p", show: true, prices: {}, documents: [c] }] }), pinned), "error"), ["not_eligible"]);
    assert.deepEqual(kinds(checkCatalogue(catalogue({ documents: [{ code: c, title: retired.title, sellable: true }] }), pinned), "error"), ["not_eligible"]);
    // a pack checkout accepts (listed && sellable) though the build doesn't show it
    assert.deepEqual(kinds(checkCatalogue(catalogue({ packs: [{ id: "p", listed: true, sellable: true, show: false, documents: [c] }] }), pinned), "error"), ["not_eligible"]);
    const f = checkCatalogue(catalogue({ documents: [...catalogue().documents, { code: c, title: retired.title, sellable: false }] }), pinned);
    assert.deepEqual(kinds(f), ["retired_reference"]);
    assert.equal(f[0].severity, "warning");
  });

  test("a code that isn't public (unknown, page B, reserved, internal) fails wherever it is", () => {
    for (const cat of [
      catalogue({ packs: [{ id: "p", show: true, prices: {}, documents: [NOT_PUBLIC] }] }),
      catalogue({ documents: [...catalogue().documents, { code: NOT_PUBLIC, title: "x", sellable: false }] }),
    ]) assert.deepEqual(kinds(checkCatalogue(cat, pinned), "error"), ["unknown_code"]);
  });

  test("a title that differs from the DCR fails; dash, quote and spacing typography doesn't", () => {
    const cat = catalogue({ documents: [{ code: bare(live), title: `${live.title} (old)`, sellable: true }] });
    assert.deepEqual(kinds(checkCatalogue(cat, pinned), "error"), ["title_mismatch"]);
    assert.deepEqual(checkCatalogue(catalogue({ documents: [{ code: bare(live), title: `  ${live.title.toUpperCase()} `, sellable: true }] }), pinned), []);
    assert.equal(normTitle("Pre–Start  Meeting"), normTitle("pre - start meeting"));
  });

  test("stamp: equal to the lock passes; different, partial or missing fails", () => {
    assert.deepEqual(kinds(checkCatalogue(catalogue({ dcr_revision: 22 }), pinned), "error"), ["stamp_mismatch"]);
    // the stamp names the full dcr.json, not the public extract
    assert.deepEqual(kinds(checkCatalogue(catalogue({ dcr_sha256: LOCK.sha256 }), pinned), "error"), ["stamp_mismatch"]);
    assert.deepEqual(kinds(checkCatalogue(catalogue({ dcr_sha256: undefined }), pinned), "error"), ["stamp_mismatch"]);
    assert.deepEqual(kinds(checkCatalogue(catalogue({ dcr_revision: undefined, dcr_sha256: undefined }), pinned), "error"), ["not_stamped"]);
  });

  test("the committed catalogue has no finding against Rev23 and is as generated", async () => {
    const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
    assert.deepEqual(checkCatalogue(cat, pinned), []);
    assert.deepEqual(checkGenerated(cat), []);
    assert.ok(shownCodes(cat).size > 0);
    assert.equal(fullCode("SAF-SWMS-CARP-001"), "SG-F-SAF-SWMS-CARP-001");
  });
});

describe("catalogue.json as generated (hand edits fail)", () => {
  const committed = JSON.parse(execFileSync("git", ["show", "HEAD:data/catalogue.json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
  const fresh = () => structuredClone(committed);
  const drift = (cat) => checkGenerated(cat).map((f) => f.message);

  test("each kind of hand edit is caught", () => {
    const listed = (cat) => cat.packs.find((p) => p.show && p.documents.length > 1);
    const unlisted = (cat) => cat.packs.find((p) => !p.listed && p.sellable);
    const notSold = (cat) => cat.packs.find((p) => p.problem && p.documents.length);
    const edits = {
      "an unlisted pack shown": (c) => { unlisted(c).show = true; },
      "a pack with a problem made sellable": (c) => { notSold(c).sellable = true; },
      "a member added to a pack": (c) => { const p = listed(c); p.documents.push(c.documents.find((d) => !p.documents.includes(d.code)).code); },
      "a member removed from a pack": (c) => { listed(c).documents.pop(); },
      "a document made unsellable": (c) => { c.documents.find((d) => d.code === listed(c).documents[0]).sellable = false; },
      "one document price changed": (c) => { c.documents[0].price += 1; },
      "a document listed twice": (c) => { c.documents.push({ ...c.documents[0] }); },
      // Pricing Rev06: only a sellable pack in a purchasable launch wave is shown.
      "a later-wave pack shown": (c) => { const p = c.packs.find((x) => x.listed && x.sellable && x.purchasable === false); p.show = true; },
      "a later-wave pack made purchasable": (c) => { const p = c.packs.find((x) => x.listed && x.sellable && x.purchasable === false); p.purchasable = true; p.show = true; },
      "a March pack moved to a later wave": (c) => { c.packs.find((x) => x.show && x.purchasable).launch_wave = "later"; },
    };
    for (const [what, edit] of Object.entries(edits)) {
      const cat = fresh();
      edit(cat);
      assert.ok(drift(cat).length > 0, `not caught: ${what}`);
      assert.ok(checkGenerated(cat).every((f) => f.kind === "generated_drift" && f.severity === "error"));
    }
  });

  test("dcr-check fails a hand-edited catalogue", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcr-t07-gen-"));
    try {
      await cp(path.join(ROOT, "dcr.lock"), path.join(dir, "dcr.lock"));
      await cp(path.join(ROOT, "dcr.allowlist.json"), path.join(dir, "dcr.allowlist.json"));
      const cat = fresh();
      cat.packs.find((p) => !p.listed && p.sellable).show = true;
      await cp(path.join(ROOT, "data"), path.join(dir, "data"), { recursive: true });
      await writeFile(path.join(dir, "data/catalogue.json"), JSON.stringify(cat, null, 1));
      const r = runDcrCheck({ root: dir, vendorDir: path.join(ROOT, "vendor/siteguard-dcr") });
      assert.deepEqual([...new Set(r.errors.map((f) => f.kind))], ["generated_drift"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the build refuses", () => {
  const build = (env) => spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], { env: { ...process.env, ...env }, encoding: "utf8" });

  test("an extract that does not verify", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcr-t07-build-"));
    try {
      const lockPath = path.join(dir, "dcr.lock");
      await writeFile(lockPath, JSON.stringify({ ...LOCK, sha256: "f".repeat(64) }));
      const r = build({ DCR_LOCK_PATH: lockPath, DIST_DIR: path.join(dir, "dist") });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /DCR: the public extract pinned in dcr\.lock does not verify/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a catalogue that shows a retired code", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcr-t07-build-"));
    try {
      const cat = JSON.parse(await readFile(path.join(ROOT, "data/catalogue.json"), "utf8"));
      const p = cat.packs.find((x) => x.show && x.prices);
      p.documents = [...p.documents, bare(retired)];
      const catPath = path.join(dir, "catalogue.json");
      await writeFile(catPath, JSON.stringify(cat));
      const r = build({ CATALOGUE_PATH: catPath, DIST_DIR: path.join(dir, "dist") });
      assert.equal(r.status, 1);
      assert.match(r.stdout, new RegExp(`ERROR: DCR: \\[not_eligible\\] ${bare(retired)} is Retired`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dcr-check (CI)", () => {
  test("passes on this repo", () => {
    const r = runDcrCheck({ root: ROOT });
    assert.deepEqual(r.errors, []);
    assert.equal(r.extract.sha256, LOCK.sha256);
  });

  test("fails on a stale or wrong-revision allow-list", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dcr-t07-allow-"));
    try {
      const allowlistPath = path.join(dir, "a.json");
      await writeFile(allowlistPath, JSON.stringify({ dcr_revision: 22, excluded_paths: [], exceptions: [
        { kind: "unknown_code", file: "data/catalogue.json", codes: [fullCode(NOT_PUBLIC)], why: "test" }] }));
      const r = runDcrCheck({ root: ROOT, allowlistPath });
      assert.deepEqual([...new Set(r.errors.map((f) => f.kind))].sort(), ["allowlist_invalid", "allowlist_stale"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the vendored extract keeps its bytes in git (-text)", () => {
    const out = execFileSync("git", ["check-attr", "text", "--", `vendor/siteguard-dcr/${LOCK.path}`], { cwd: ROOT, encoding: "utf8" });
    assert.match(out.trim(), /: text: unset$/);
  });
});
