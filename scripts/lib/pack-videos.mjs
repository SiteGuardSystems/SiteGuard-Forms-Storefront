// SiteGuard Education videos on the FORMS pack pages (data/pack-videos.json).
// Storefront only. A "See how the forms work" band (anchor #videos) with:
//   - the lead video (data "lead", e.g. "What is SiteGuard FORMS") first, on
//     every pack page and the pack index pages; then
//   - the how-to videos for the documents actually sold on that page: a video
//     shows when one of its "documents" is in a pack on the page, or, with
//     "families" (e.g. ["SWMS"]), when the page sells any document of that
//     family (the family is the code's second part: SAF-SWMS-CARP-001).
// Only published videos render (a youtube_url, checked by video.mjs). With
// none published the band is "" and the built site is unchanged. Players, the
// YouTube facade (nothing from Google loads until play) and the CSP are the
// shared video.mjs code.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";
import { checkVideo, normalizeVideo, videoCsp, videoJsonLd, videoPlayer } from "./video.mjs";

export const KINDS = ["marketing", "how-to"];

/** Read and check data/pack-videos.json. Returns { lead, videos, problems }:
 *  videos is the list of { entry, video }, where video is null until the
 *  entry is a complete, published video; lead is the lead's { entry, video } or null.
 *  PACK_VIDEOS_PATH (tests) points at another file. */
export async function loadPackVideos(root, file = process.env.PACK_VIDEOS_PATH) {
  const problems = [];
  let data;
  try { data = JSON.parse(await readFile(file ? path.resolve(file) : path.join(root, "data", "pack-videos.json"), "utf8")); } catch (e) {
    if (e.code !== "ENOENT") problems.push(`pack-videos.json: ${e.message}`);
    return { lead: null, videos: [], problems };
  }
  return parsePackVideos(data, problems);
}

export function parsePackVideos(data, problems = []) {
  const videos = [];
  const seen = new Set();
  for (const raw of data?.videos ?? []) {
    const where = `pack-videos.json ${raw?.doc ?? "?"}`;
    if (!raw?.doc || seen.has(raw.doc)) { problems.push(`${where}: doc missing or listed twice`); continue; }
    seen.add(raw.doc);
    if (!KINDS.includes(raw.kind)) { problems.push(`${where}: kind must be ${KINDS.join(" or ")}`); continue; }
    const v = normalizeVideo(raw);
    let video = null;
    if (v?.provider) {
      const p = checkVideo(v);
      for (const m of p) problems.push(`${where}: ${m}`);
      if (!p.length) video = v;
    }
    videos.push({ entry: raw, video });
  }
  const lead = data?.lead ? videos.find((x) => x.entry.doc === data.lead) ?? null : null;
  if (data?.lead && !lead) problems.push(`pack-videos.json: lead ${data.lead} is not in videos`);
  return { lead, videos, problems };
}

const familyOf = (code) => String(code).split("-")[1] ?? "";

/** The published how-to videos for a set of document codes, in data order. */
export function howTosFor(pv, codes) {
  const set = new Set(codes);
  const fams = new Set([...set].map(familyOf));
  return (pv?.videos ?? []).filter(({ entry, video }) => video && entry.kind === "how-to"
    && ((entry.documents ?? []).some((c) => set.has(c)) || (entry.families ?? []).some((f) => fams.has(f))));
}

/** The document codes in a list of packs. */
export const codesOf = (packs) => packs.flatMap((p) => p.documents ?? []);

/** The band for a page selling `codes` ("" when nothing published fits). */
export function packVideosSection(pv, codes = [], { heading = "See how the forms work" } = {}) {
  const lead = pv?.lead?.video ?? null;
  const how = howTosFor(pv, codes);
  if (!lead && !how.length) return "";
  return `<section class="band band-grey pack-videos" id="videos" aria-labelledby="videos-h"><div class="wrap">
  <h2 id="videos-h">${esc(heading)}</h2>
  ${lead ? `<div class="video-frame">${videoPlayer(lead)}</div>
  <p class="video-caption">${esc(lead.description)}</p>` : ""}
  ${how.length ? `<ul class="edu-grid">${how.map(({ video }) => `<li class="edu-card"><div class="video-frame">${videoPlayer(video)}</div>
    <h3>${esc(video.title)}</h3><p>${esc(video.description)}</p></li>`).join("")}</ul>` : ""}
</div></section>`;
}

/** VideoObject JSON-LD for the videos the band shows on that page. */
export function packVideosJsonLd(pv, codes, origin) {
  const vids = [pv?.lead?.video, ...howTosFor(pv, codes).map((x) => x.video)].filter(Boolean);
  return vids.map((v) => videoJsonLd(v, origin));
}

/** CSP sources ({ frame, img }) the published pack videos need. */
export function packVideosCsp(pv) {
  const out = { frame: new Set(), img: new Set() };
  for (const { video } of pv?.videos ?? []) {
    const c = videoCsp(video);
    c.frame.forEach((x) => out.frame.add(x)); c.img.forEach((x) => out.img.add(x));
  }
  return { frame: [...out.frame], img: [...out.img] };
}
