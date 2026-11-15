// SiteGuard Education videos on the FORMS pack pages (scripts/lib/pack-videos.mjs,
// data/pack-videos.json) and the sheet filler (scripts/fill-pack-videos.mjs).
// Synthetic YouTube IDs only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { howTosFor, loadPackVideos, packVideosCsp, packVideosJsonLd, packVideosSection, parsePackVideos } from "../scripts/lib/pack-videos.mjs";
import { fill, parseCsv } from "../scripts/fill-pack-videos.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vid = (doc, kind, extra = {}) => ({ doc, kind, title: `Title ${doc}`, description: `About ${doc}`, youtube_url: "", upload_date: "", documents: [], ...extra });
const pub = (id) => ({ youtube_url: `https://youtu.be/${id}`, upload_date: "2026-11-16" });
const SAMPLE = {
  lead: "MKT-2",
  videos: [
    vid("MKT-1", "marketing"),
    vid("MKT-2", "marketing", pub("leadleadAAA")),
    vid("HOW-266", "how-to", { documents: ["SAF-FRM-GEN-266"], ...pub("prestartBBB") }),
    vid("HOW-SWMS", "how-to", { documents: ["SAF-SWMS-MAS-001"], families: ["SWMS"], ...pub("swmsswmsCCC") }),
    vid("HOW-055", "how-to", { documents: ["SAF-FRM-GEN-055"] }),
  ],
};

describe("pack videos", () => {
  test("the committed map has the wave 1 videos, the FORMS video as lead, none published yet", async () => {
    const pv = await loadPackVideos(ROOT, "");
    assert.deepEqual(pv.problems, []);
    assert.equal(pv.lead.entry.doc, "SG-E-GEN-MKT-GEN-002");
    assert.equal(pv.videos.length, 15);
    assert.ok(pv.videos.every((v) => v.video === null && v.entry.youtube_url === ""));
    assert.equal(packVideosSection(pv, ["SAF-FRM-GEN-266", "SAF-SWMS-CARP-001"]), "");
    assert.deepEqual(packVideosCsp(pv), { frame: [], img: [] });
  });

  test("nothing published: no band, no JSON-LD, no CSP change", () => {
    const pv = parsePackVideos({ lead: "MKT-2", videos: SAMPLE.videos.map((v) => ({ ...v, youtube_url: "", upload_date: "" })) });
    assert.equal(packVideosSection(pv, ["SAF-FRM-GEN-266"]), "");
    assert.deepEqual(packVideosJsonLd(pv, ["SAF-FRM-GEN-266"], "https://x"), []);
    assert.deepEqual(packVideosCsp(pv), { frame: [], img: [] });
  });

  test("a trade pack (SWMS only) gets the lead and the SWMS how-to, not the form how-tos", () => {
    const pv = parsePackVideos(SAMPLE);
    const html = packVideosSection(pv, ["SAF-SWMS-CARP-001", "SAF-PLN-GEN-201"]);
    assert.match(html, /id="videos"/);
    assert.match(html, /See how the forms work/);
    assert.match(html, /data-yt="leadleadAAA"/);
    assert.match(html, /data-yt="swmsswmsCCC"/);
    assert.doesNotMatch(html, /prestartBBB/);
    assert.match(html, /youtube\.com\/watch\?v=leadleadAAA/, "without JavaScript the poster links to YouTube");
    assert.doesNotMatch(html, /<iframe|<script/, "no YouTube player or script on page load");
  });

  test("a pack with the form gets its how-to; an unpublished one never shows", () => {
    const pv = parsePackVideos(SAMPLE);
    assert.deepEqual(howTosFor(pv, ["SAF-FRM-GEN-266", "SAF-FRM-GEN-055"]).map((x) => x.entry.doc), ["HOW-266"]);
    const ld = packVideosJsonLd(pv, ["SAF-FRM-GEN-266"], "https://siteguardforms.com.au");
    assert.deepEqual(ld.map((x) => x.embedUrl), ["https://www.youtube-nocookie.com/embed/leadleadAAA", "https://www.youtube-nocookie.com/embed/prestartBBB"]);
    assert.ok(ld.every((x) => x["@type"] === "VideoObject"));
  });

  test("an index page (no documents) shows the lead alone", () => {
    const html = packVideosSection(parsePackVideos(SAMPLE), []);
    assert.match(html, /leadleadAAA/);
    assert.doesNotMatch(html, /edu-grid/);
  });

  test("published videos open the CSP for youtube-nocookie and the YouTube thumbnails", () => {
    assert.deepEqual(packVideosCsp(parsePackVideos(SAMPLE)), { frame: ["https://www.youtube-nocookie.com"], img: ["https://i.ytimg.com"] });
  });

  test("bad entries are reported, and a missing lead", () => {
    const pv = parsePackVideos({ lead: "NOPE", videos: [vid("A", "film"), vid("B", "how-to", { youtube_url: "https://example.com/x" }), vid("B", "how-to")] });
    assert.ok(pv.problems.some((p) => /kind must be/.test(p)));
    assert.ok(pv.problems.some((p) => /listed twice/.test(p)));
    assert.ok(pv.problems.some((p) => /isn.t a YouTube video link/.test(p)));
    assert.ok(pv.problems.some((p) => /lead NOPE/.test(p)));
  });
});

describe("filling the map from the upload sheet", () => {
  test("links from the sheet are set with the upload date; blank rows and bad links are left alone", () => {
    const csv = 'n,doc,title,youtube_url\r\n1,MKT-2,"A, quoted ""title""",https://www.youtube.com/watch?v=leadleadAAA\r\n2,HOW-055,x,\r\n3,HOW-266,x,https://vimeo.com/1\r\n4,NOT-THERE,x,https://youtu.be/abcdefghijk\r\n';
    const sheet = parseCsv(csv);
    assert.equal(sheet[0].title, 'A, quoted "title"');
    const data = { lead: "MKT-2", videos: SAMPLE.videos.map((v) => ({ ...v, youtube_url: "", upload_date: "" })) };
    const { changed, problems } = fill(data, sheet, "2026-11-16");
    assert.deepEqual(changed, ["MKT-2"]);
    assert.equal(problems.length, 2);
    const m = data.videos.find((v) => v.doc === "MKT-2");
    assert.equal(m.youtube_url, "https://www.youtube.com/watch?v=leadleadAAA");
    assert.equal(m.upload_date, "2026-11-16");
    assert.equal(parsePackVideos(data).lead.video.youtube_id, "leadleadAAA");
  });
});

describe("the built site with a published map", () => {
  test("the carpentry page carries the band at #videos; the trade-packs index has the lead", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sg-packvid-"));
    try {
      const data = JSON.parse(await readFile(path.join(ROOT, "data/pack-videos.json"), "utf8"));
      const ids = { "SG-E-GEN-MKT-GEN-002": "leadleadAAA", "SG-E-SAF-HOW-MAS-001": "swmsswmsCCC", "SG-E-SAF-HOW-GEN-266": "prestartBBB" };
      for (const v of data.videos) if (ids[v.doc]) Object.assign(v, pub(ids[v.doc]));
      const file = path.join(dir, "pack-videos.json");
      await writeFile(file, JSON.stringify(data));
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-site.mjs")], {
        env: { ...process.env, PACK_VIDEOS_PATH: file, DIST_DIR: path.join(dir, "dist") }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const carp = await readFile(path.join(dir, "dist/trade-packs/carpentry/index.html"), "utf8");
      assert.match(carp, /<section class="band band-grey pack-videos" id="videos"/);
      assert.match(carp, /data-yt="leadleadAAA"/);
      assert.match(carp, /data-yt="swmsswmsCCC"/);
      assert.doesNotMatch(carp, /prestartBBB/, "trade packs sell SWMS, plans and ITPs, not the pre-start form");
      assert.match(carp, /"@type":"VideoObject"/);
      const idx = await readFile(path.join(dir, "dist/trade-packs/index.html"), "utf8");
      assert.match(idx, /data-yt="leadleadAAA"/);
      assert.doesNotMatch(idx, /swmsswmsCCC/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
