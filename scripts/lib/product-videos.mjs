// FORMS product videos on the pack pages (data/product-videos.json): one slot
// per page type -- trade, builder, high-risk, subscription. Storefront only (not
// shared with siteguard-website). Each video is checked and rendered with the
// shared intro-video code (video.mjs), so the player, the YouTube facade and
// the CSP work the same way.
//
// A slot whose video isn't published yet (no youtube_url / provider) shows a
// plain placeholder in a preview build and nothing in a production build.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";
import { checkVideo, normalizeVideo, videoCsp, videoPlayer } from "./video.mjs";

export const SLOTS = ["trade", "builder", "high-risk", "subscription"];

/** Read and check data/product-videos.json. Returns { slots, problems }:
 *  slots maps a slot to { entry, video }, where video is null until the entry
 *  is a complete, published video. */
export async function loadProductVideos(root) {
  const problems = [];
  const slots = new Map();
  let data;
  try { data = JSON.parse(await readFile(path.join(root, "data", "product-videos.json"), "utf8")); } catch (e) {
    if (e.code !== "ENOENT") problems.push(`product-videos.json: ${e.message}`);
    return { slots, problems };
  }
  for (const raw of data.videos ?? []) {
    if (!SLOTS.includes(raw.slot)) { problems.push(`product-videos.json: ${raw.id ?? "?"}: slot must be one of ${SLOTS.join(", ")}`); continue; }
    if (slots.has(raw.slot)) { problems.push(`product-videos.json: two videos for the ${raw.slot} slot`); continue; }
    const v = normalizeVideo(raw);
    let video = null;
    if (v?.provider) {
      const p = checkVideo(v);
      for (const m of p) problems.push(`product-videos.json: ${raw.id ?? raw.slot}: ${m}`);
      if (!p.length) video = v;
    }
    slots.set(raw.slot, { entry: raw, video });
  }
  return { slots, problems };
}

/** CSP sources ({ frame, img }) the published product videos need. */
export function productVideosCsp(pv) {
  const out = { frame: new Set(), img: new Set() };
  for (const { video } of pv?.slots?.values() ?? []) {
    const c = videoCsp(video);
    c.frame.forEach((x) => out.frame.add(x)); c.img.forEach((x) => out.img.add(x));
  }
  return { frame: [...out.frame], img: [...out.img] };
}

/** The section for one slot: the video, a placeholder (preview builds only),
 *  or nothing. */
export function productVideo(pv, slot, { production = false } = {}) {
  const s = pv?.slots?.get(slot);
  if (!s) return "";
  const { entry, video } = s;
  const id = `video-${slot}-h`;
  if (video) {
    return `<section class="band product-video" aria-labelledby="${id}" data-video-slot="${esc(slot)}"><div class="wrap">
  <h2 id="${id}">${esc(entry.heading || video.title)}</h2>
  <div class="video-frame">${videoPlayer(video)}</div>
  <p class="video-caption">${esc(video.description)}</p>
</div></section>`;
  }
  if (production) return "";
  return `<section class="band product-video" aria-labelledby="${id}" data-video-slot="${esc(slot)}" data-video-placeholder="1"><div class="wrap">
  <h2 id="${id}">${esc(entry.heading || entry.title)}</h2>
  <div class="video-placeholder"><p><strong>Video placeholder.</strong> ${esc(entry.title)}. The video goes here once it is published.</p></div>
</div></section>`;
}
