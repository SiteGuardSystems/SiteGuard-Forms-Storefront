// S26 (audit, 7 Nov 2026): beta unless data/site-mode.json clearly says otherwise.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSiteMode } from "../lib/site-mode.js";

test("a missing, broken or unclear site-mode.json is beta (no orders)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "site-mode-"));
  const f = (name, text) => { const p = path.join(dir, name); return writeFile(p, text).then(() => p); };
  for (const [file, why] of [
    [path.join(dir, "missing.json"), /can't be read/],
    [await f("broken.json", "{ beta: false"), /can't be read/],
    [await f("array.json", "[]"), /isn't an object/],
    [await f("nobeta.json", JSON.stringify({ app_status: "presale" })), /no true\/false beta/],
    [await f("string.json", JSON.stringify({ beta: "false" })), /no true\/false beta/],
  ]) {
    const r = readSiteMode(file);
    assert.equal(r.mode.beta, true, file);
    assert.match(r.problem, why);
  }
  assert.equal(readSiteMode(await f("nobeta2.json", JSON.stringify({ app_status: "presale" }))).mode.app_status, "presale");
});

test("a clear beta false opens ordering, and true keeps it closed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "site-mode-"));
  const p = path.join(dir, "m.json");
  await writeFile(p, JSON.stringify({ beta: false, app_status: "coming_soon" }));
  assert.deepEqual(readSiteMode(p), { mode: { beta: false, app_status: "coming_soon" }, problem: null });
  await writeFile(p, JSON.stringify({ beta: true }));
  assert.equal(readSiteMode(p).mode.beta, true);
});
