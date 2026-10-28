// SiteGuard Education hub (scripts/lib/education.mjs). Same file in both sites.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEducation, educationBody, seriesBody, educationCsp, educationJsonLd } from "../scripts/lib/education.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = { provider: "youtube", youtube_id: "dQw4w9WgXcQ", title: "How to read a SWMS", description: "A short how-to.", upload_date: "2026-11-01" };
const G = (title, slug, videos) => ({ title, slug, videos });
const D = (groups) => ({ channel_name: "SiteGuard Education", channel_url: "https://www.youtube.com/channel/UCegFXOpYr0-gWG0t0H4as1Q", groups });
async function fixture(d) {
  const root = await mkdtemp(path.join(tmpdir(), "edu-"));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/education.json"), JSON.stringify(d));
  return root;
}

test("every series has a tab, empty ones say so; a pasted YouTube link becomes a player with share links", async () => {
  const { edu, problems } = await loadEducation(await fixture(D([G("How-tos", "how-tos", [{ ...V, youtube_id: undefined, provider: undefined, youtube_url: "https://youtu.be/dQw4w9WgXcQ?si=x", download_url: "https://example.com/a.mp4" }]), G("Inductions", "inductions", [])])));
  assert.deepEqual(problems, []);
  const html = educationBody(edu);
  assert.match(html, /<a href="\/education\/how-tos\/">How-tos/);
  assert.match(html, /<a href="\/education\/inductions\/">Inductions<\/a>/);
  assert.match(html, /No videos in this series yet/);
  assert.match(html, /data-yt="dQw4w9WgXcQ"/);
  assert.match(html, /data-copy="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
  assert.match(html, /href="https:\/\/example\.com\/a\.mp4" rel="noopener">Download/);
  const series = seriesBody(edu, "inductions");
  assert.match(series, /aria-current="page">Inductions/);
  assert.match(series, /No videos in this series yet/);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/channel\/UCegFXOpYr0-gWG0t0H4as1Q" rel="noopener">Subscribe on YouTube/);
  assert.equal(educationJsonLd(edu, "https://x.example").itemListElement[0].item["@type"], "VideoObject");
  assert.deepEqual(educationCsp(edu).frame, ["https://www.youtube-nocookie.com"]);
});

test("a broken video or channel is reported and the video left out", async () => {
  const { edu, problems } = await loadEducation(await fixture({ ...D([G("How-tos", "how-tos", [{ ...V, youtube_id: "nope" }, { ...V, youtube_id: undefined, youtube_url: "https://vimeo.com/123" }]), G("x", "Bad Slug", [])]), channel_url: "https://example.com" }));
  assert.ok(problems.some((m) => /channel_url/.test(m)));
  assert.ok(problems.some((m) => /youtube_id/.test(m)));
  assert.ok(problems.some((m) => /youtube_url isn't a YouTube video link/.test(m)));
  assert.ok(problems.some((m) => /slug/.test(m)));
  assert.equal(edu.groups[0].videos.length, 0);
});

test("youtubeId reads every common YouTube link form", async () => {
  const { youtubeId } = await import("../scripts/lib/video.mjs");
  for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1", "https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"]) assert.equal(youtubeId(u), "dQw4w9WgXcQ", u);
  for (const u of ["https://vimeo.com/1", "not a url", "https://www.youtube.com/channel/UCegFXOpYr0-gWG0t0H4as1Q"]) assert.equal(youtubeId(u), null, u);
});

test("this site's education.json is valid", async () => {
  const { edu, problems } = await loadEducation(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(edu.groups.length > 0);
});
