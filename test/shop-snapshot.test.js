// WP-S8: the shop pages and the cart moved into scripts/lib/shop.mjs, cart.mjs
// and cart-browser.js (shared with siteguard-website). The built site must be
// exactly what it was before: test/fixtures/dist-snapshot.json was made from
// a build of the base branch (p3-forms-site-launch, 6067233) before the move.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { snapshot } from "./dist-snapshot.mjs";
import { cartBrowserParts, spliceCart } from "../scripts/lib/cart.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the built site is byte-identical to the snapshot taken before the extraction", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-snap-"));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], { cwd: ROOT, env: { ...process.env, DIST_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const want = JSON.parse(await readFile(path.join(ROOT, "test/fixtures/dist-snapshot.json"), "utf8"));
    const got = await snapshot(dir);
    assert.deepEqual(Object.keys(got), Object.keys(want), "the same files");
    for (const [f, h] of Object.entries(want)) assert.equal(got[f], h, `${f} changed`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("app.js is the template with both parts of cart-browser.js spliced in", async () => {
  const parts = await cartBrowserParts();
  const tpl = await readFile(path.join(ROOT, "public/assets/app.js"), "utf8");
  const out = spliceCart(tpl, parts).replace(/\r\n/g, "\n");
  assert.ok(!out.includes("//@@cart"));
  for (const p of parts) assert.ok(out.includes(p));
  assert.ok(parts[0].includes("function add(item)") && parts[1].includes('fetch("/api/checkout"'));
  assert.throws(() => spliceCart("no markers", parts), /expected one/);
});

test("shop.mjs, cart.mjs and cart-browser.js are identical in siteguard-website (when checked out beside this repo)", async () => {
  for (const sib of ["../siteguard-website", "../_wt_website_s8"]) {
    const other = path.resolve(ROOT, sib, "scripts/lib");
    if (!existsSync(path.join(other, "shop.mjs"))) continue;
    for (const f of ["shop.mjs", "cart.mjs", "cart-browser.js"]) {
      const a = (await readFile(path.join(ROOT, "scripts/lib", f), "utf8")).replace(/\r\n/g, "\n");
      const b = (await readFile(path.join(other, f), "utf8")).replace(/\r\n/g, "\n");
      assert.equal(a, b, `${f} differs from ${sib}`);
    }
  }
});
