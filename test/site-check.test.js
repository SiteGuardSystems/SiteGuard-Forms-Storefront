// S7 (overnight 10-11 Nov 2026): the built site has no broken internal links, the
// SiteGuard lockup in every page header, and no page that links back to itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSite, urlOf } from "../scripts/check-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCKUP = '<header><a class="brand" href="/"><img src="/assets/shield.png" alt=""><span class="brand-name">SiteGuard <b>FORMS</b></span></a></header>';

test("the built site passes: links resolve, every header has the lockup, no page loops", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-check-"));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], { cwd: ROOT, env: { ...process.env, DIST_DIR: dir }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { pages, problems } = await checkSite(dir);
    assert.ok(pages > 50, `${pages} pages`);
    assert.deepEqual(problems, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the check finds a broken link, a missing lockup and a page that loops", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sg-check-"));
  try {
    await mkdir(path.join(dir, "about"), { recursive: true });
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "assets", "shield.png"), "");
    await writeFile(path.join(dir, "index.html"), `<html><head></head><body>${LOCKUP}<main><a href="/about/?x=1">About</a> <a href="/api/lead">ok</a> <a href="/missing/">gone</a></main></body></html>`);
    await writeFile(path.join(dir, "about", "index.html"), `<html><head></head><body><header>SiteGuard</header><main><a href="/about/">again</a> <a href="#top">top</a></main></body></html>`);
    const { problems } = await checkSite(dir);
    assert.deepEqual(problems.sort(), [
      "/: broken href /missing/",
      "/about/: a body link loops back to the page itself (/about/)",
      "/about/: no SiteGuard lockup (shield and wordmark, linking home) in the header",
    ]);
    assert.equal(urlOf("about/index.html"), "/about/");
    assert.equal(urlOf("index.html"), "/");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
