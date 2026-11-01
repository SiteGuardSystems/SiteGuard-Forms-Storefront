// The founding-offer panel in a presale build, and the FORMS product video
// slots (rollout P3, March 2027 launch).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProductVideos, productVideo, productVideosCsp } from "../scripts/lib/product-videos.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function buildWith(dir, siteMode) {
  const mode = path.join(dir, "site-mode.json");
  return writeFile(mode, JSON.stringify(siteMode)).then(() =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], {
      env: { ...process.env, SITE_MODE_PATH: mode, DIST_DIR: path.join(dir, "dist") }, encoding: "utf8",
    }));
}

describe("founding-offer panel", () => {
  test("a presale build shows it on the home and subscriptions pages only, linking to the Systems founding page", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-founding-"));
    try {
      const r = await buildWith(dir, { beta: true, app_status: "presale" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const dist = path.join(dir, "dist");
      for (const f of ["index.html", "subscriptions/index.html"]) {
        const html = await readFile(path.join(dist, f), "utf8");
        assert.match(html, /data-founding-panel/, f);
        assert.match(html, /href="https:\/\/www\.siteguardsystems\.com\.au\/app\/founding-offer\/"/, f);
        assert.match(html, /opens in June 2027/, f);
        assert.match(html, /first 20 places/, f);
        assert.match(html, /15% off your first year,<\/strong> paid annually/, f);
        assert.match(html, /Access from June 2027/, f);
        assert.match(html, /matching FORMS pack free from March 2027/, f);
        assert.match(html, /a free month for each month of delay, or a refund of the unused prepayment/, f);
        assert.doesNotMatch(html, /money[- ]back/i, f);
        assert.doesNotMatch(html, /data-api=/, "no live count until founding_places_api is set");
      }
      assert.doesNotMatch(await readFile(path.join(dist, "trade-packs/index.html"), "utf8"), /data-founding-panel/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the live-count hook is wired only for a same-origin path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-founding-"));
    try {
      const ok = await buildWith(dir, { beta: true, app_status: "presale", founding_places_api: "/api/founding/places" });
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.match(await readFile(path.join(dir, "dist/index.html"), "utf8"), /data-founding-places data-total="20" data-api="\/api\/founding\/places"/);
      const bad = await buildWith(dir, { beta: true, app_status: "presale", founding_places_api: "https://example.com/x" });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stdout + bad.stderr, /founding_places_api must be a same-origin path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unknown app_status fails the build", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-founding-"));
    try {
      const r = await buildWith(dir, { beta: true, app_status: "pre-sale" });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /app_status must be one of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("product videos", () => {
  const withData = async (videos, fn) => {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-pv-"));
    try {
      await mkdir(path.join(dir, "data"));
      await writeFile(path.join(dir, "data/product-videos.json"), JSON.stringify({ videos }));
      await fn(await loadProductVideos(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const base = { id: "PRD-001", slot: "trade", heading: "H", title: "T", description: "D", youtube_url: "", upload_date: "" };

  test("the committed file has the four FORMS videos, one per slot, none published yet", async () => {
    const pv = await loadProductVideos(ROOT);
    assert.deepEqual(pv.problems, []);
    assert.deepEqual([...pv.slots.keys()].sort(), ["builder", "high-risk", "subscription", "trade"]);
    assert.deepEqual([...pv.slots.values()].map((s) => s.entry.id).sort(), ["PRD-001", "PRD-002", "PRD-003", "PRD-004"]);
  });

  test("unpublished: a placeholder in a preview build, nothing in production, no CSP change", async () => {
    await withData([base], (pv) => {
      assert.match(productVideo(pv, "trade"), /data-video-placeholder="1"/);
      assert.equal(productVideo(pv, "trade", { production: true }), "");
      assert.deepEqual(productVideosCsp(pv), { frame: [], img: [] });
    });
  });

  test("published: the YouTube facade, and the CSP opens youtube-nocookie", async () => {
    await withData([{ ...base, youtube_url: "https://youtu.be/abcdefghijk", upload_date: "2027-01-31" }], (pv) => {
      const html = productVideo(pv, "trade", { production: true });
      assert.match(html, /data-yt="abcdefghijk"/);
      assert.doesNotMatch(html, /placeholder/);
      assert.deepEqual(productVideosCsp(pv).frame, ["https://www.youtube-nocookie.com"]);
    });
  });

  test("a bad entry is reported", async () => {
    await withData([{ ...base, slot: "nope" }, { ...base, slot: "builder", youtube_url: "https://youtu.be/abcdefghijk" }], (pv) => {
      assert.equal(pv.problems.length, 2);
    });
  });
});
