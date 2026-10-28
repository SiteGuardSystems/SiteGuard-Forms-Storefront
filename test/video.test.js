// Landing-page intro video (scripts/lib/video.mjs). The same file and the
// same tests live in siteguard-website and SiteGuard-Forms-Storefront.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadVideo, introVideo, videoJsonLd, withVideoCsp } from "../scripts/lib/video.mjs";

async function fixture(video) {
  const root = await mkdtemp(path.join(tmpdir(), "video-"));
  await mkdir(path.join(root, "data"));
  if (video !== undefined) await writeFile(path.join(root, "data/intro-video.json"), JSON.stringify(video));
  return root;
}
const BASE = { title: "Meet SiteGuard", description: "A two-minute introduction.", upload_date: "2026-11-01" };
const YT = { ...BASE, provider: "youtube", youtube_id: "dQw4w9WgXcQ" };
const FILE = { ...BASE, provider: "file", file: "/assets/video/intro.mp4", poster: "/assets/video/intro.jpg", captions: "/assets/video/intro.en.vtt" };
const CSP = "default-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

test("no file, or no provider: nothing renders and the CSP is unchanged", async () => {
  for (const v of [undefined, { provider: "" }]) {
    const { video, problems } = await loadVideo(await fixture(v));
    assert.equal(video, null);
    assert.deepEqual(problems, []);
    assert.equal(introVideo(video), "");
    assert.equal(videoJsonLd(video, "https://x.example"), null);
    assert.equal(withVideoCsp(CSP, video), CSP);
  }
});

test("YouTube: click-to-load poster that links to YouTube without JavaScript", async () => {
  const { video, problems } = await loadVideo(await fixture(YT));
  assert.deepEqual(problems, []);
  const html = introVideo(video);
  assert.match(html, /href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
  assert.match(html, /data-yt="dQw4w9WgXcQ"/);
  assert.match(html, /src="https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg"/);
  assert.ok(!/<iframe/.test(html), "the player is not loaded until play is pressed");
  assert.ok(!/ style="/.test(html));
  const csp = withVideoCsp(CSP, video);
  assert.match(csp, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com/);
  assert.match(csp, /img-src 'self' data: https:\/\/i\.ytimg\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(videoJsonLd(video, "https://x.example").embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
});

test("YouTube with a local poster doesn't open img-src", async () => {
  const { video } = await loadVideo(await fixture({ ...YT, poster: "/assets/video/intro.webp" }));
  const csp = withVideoCsp(CSP, video);
  assert.ok(!/ytimg/.test(csp));
  assert.match(introVideo(video), /src="\/assets\/video\/intro\.webp"/);
});

test("file: the browser's own player, with captions, and no CSP change", async () => {
  const { video, problems } = await loadVideo(await fixture(FILE));
  assert.deepEqual(problems, []);
  const html = introVideo(video, { heading: "See it" });
  assert.match(html, /<video class="video-file" controls preload="metadata"/);
  assert.match(html, /<source src="\/assets\/video\/intro\.mp4" type="video\/mp4">/);
  assert.match(html, /<track kind="captions" src="\/assets\/video\/intro\.en\.vtt"/);
  assert.match(html, /<h2 id="intro-video-h">See it<\/h2>/);
  assert.equal(withVideoCsp(CSP, video), CSP);
  const ld = videoJsonLd(video, "https://x.example");
  assert.equal(ld.contentUrl, "https://x.example/assets/video/intro.mp4");
  assert.equal(ld.thumbnailUrl, "https://x.example/assets/video/intro.jpg");
});

test("an incomplete or unsafe entry is reported and not shown", async () => {
  const cases = [
    [{ ...YT, youtube_id: "https://youtu.be/dQw4w9WgXcQ" }, /youtube_id/],
    [{ ...FILE, file: "https://cdn.example/intro.mp4" }, /file must be/],
    [{ ...FILE, poster: "" }, /poster is required/],
    [{ ...YT, poster: "https://elsewhere.example/p.jpg" }, /poster must be/],
    [{ ...YT, title: "" }, /title is required/],
    [{ ...YT, upload_date: "soon" }, /upload_date/],
    [{ ...YT, duration: "2 minutes" }, /duration/],
    [{ ...YT, provider: "vimeo" }, /provider must be/],
  ];
  for (const [v, re] of cases) {
    const { video, problems } = await loadVideo(await fixture(v));
    assert.equal(video, null, JSON.stringify(v));
    assert.ok(problems.some((p) => re.test(p)), `${re}: ${problems.join("; ")}`);
  }
});

test("channel link: shown under the video when set, checked as a YouTube channel", async () => {
  const ch = { channel_url: "https://www.youtube.com/channel/UCegFXOpYr0-gWG0t0H4as1Q", channel_name: "SiteGuard Education" };
  const { video, problems } = await loadVideo(await fixture({ ...FILE, ...ch }));
  assert.deepEqual(problems, []);
  assert.match(introVideo(video), /<a href="https:\/\/www\.youtube\.com\/channel\/UCegFXOpYr0-gWG0t0H4as1Q" rel="noopener">More videos on SiteGuard Education on YouTube<\/a>/);
  assert.ok(!/video-channel/.test(introVideo((await loadVideo(await fixture(FILE))).video)));
  for (const bad of [{ ...ch, channel_url: "https://evil.example/channel/x" }, { ...ch, channel_name: "" }]) {
    const r = await loadVideo(await fixture({ ...FILE, ...bad }));
    assert.equal(r.video, null);
    assert.ok(r.problems.some((m) => /channel_/.test(m)), r.problems.join("; "));
  }
});

test("titles are escaped", async () => {
  const { video } = await loadVideo(await fixture({ ...YT, title: 'A "quote" <b>' }));
  const html = introVideo(video);
  assert.ok(!html.includes("<b>"));
  assert.match(html, /A &quot;quote&quot; &lt;b&gt;/);
});
