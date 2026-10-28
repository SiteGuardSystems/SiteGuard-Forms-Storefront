// Introduction video on the landing page: shared by both SiteGuard websites
// (the same file lives in siteguard-website and SiteGuard-Forms-Storefront;
// keep them identical). Each site has its own data/intro-video.json, so each
// can show a different video.
//
// Two ways to host it:
//   "youtube"  the video's YouTube ID. The page shows a local poster (or
//              YouTube's thumbnail) with a play button and loads the player
//              from youtube-nocookie.com only when someone presses play, so
//              the page stays fast and nothing from Google loads until then.
//              Without JavaScript the play button is a plain link to YouTube.
//   "file"     an MP4 in /assets/video/, played by the browser's own player.
//              Keep it small: Cloudflare Pages refuses files over 25 MiB.
//
// Nothing renders until provider is set and the entry is complete. The
// Content-Security-Policy opens only what the chosen provider needs
// (videoCsp), so with no video the policy is unchanged.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";

export const PROVIDERS = ["youtube", "file"];
export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const LOCAL_RE = (ext) => new RegExp(`^/assets/video/[a-z0-9][a-z0-9._-]*\\.(${ext})$`);
const POSTER_RE = LOCAL_RE("jpg|jpeg|png|webp");
const MP4_RE = LOCAL_RE("mp4");
const VTT_RE = LOCAL_RE("vtt");
const CHANNEL_RE = /^https:\/\/(www\.)?youtube\.com\/(channel\/UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{3,30})\/?$/;
const DURATION_RE = /^PT(?:\d+H)?(?:\d+M)?(?:\d+S)?$/;

/** Read and check one site's intro video. Returns { video, problems };
 *  video is null when there is nothing (complete) to show. */
export async function loadVideo(root) {
  const problems = [];
  let v;
  try { v = JSON.parse(await readFile(path.join(root, "data", "intro-video.json"), "utf8")); } catch (e) {
    if (e.code !== "ENOENT") problems.push(`intro-video.json: ${e.message}`);
    return { video: null, problems };
  }
  if (!v || !v.provider) return { video: null, problems };
  const p = (m) => problems.push(`intro-video.json: ${m}`);
  if (!PROVIDERS.includes(v.provider)) p(`provider must be ${PROVIDERS.join(" or ")} (or empty for no video)`);
  if (v.provider === "youtube" && !YT_ID_RE.test(v.youtube_id ?? "")) p("youtube_id must be the 11-character ID from the YouTube link (youtube.com/watch?v=ID)");
  if (v.provider === "file" && !MP4_RE.test(v.file ?? "")) p("file must be an .mp4 in /assets/video/");
  if (v.provider === "file" && !v.poster) p("poster is required for a file video");
  if (v.poster && !POSTER_RE.test(v.poster)) p("poster must be an image in /assets/video/ (jpg, png or webp)");
  if (v.captions && !VTT_RE.test(v.captions)) p("captions must be a .vtt file in /assets/video/");
  if (!v.title || typeof v.title !== "string" || v.title.length > 90) p("title is required (up to 90 characters)");
  if (!v.description || typeof v.description !== "string" || v.description.length > 300) p("description is required (up to 300 characters)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.upload_date ?? "")) p("upload_date (YYYY-MM-DD, the day the video was published) is required");
  if (v.duration && !DURATION_RE.test(v.duration)) p('duration must be ISO 8601, e.g. "PT1M45S"');
  if (v.channel_url && !CHANNEL_RE.test(v.channel_url)) p("channel_url must be a youtube.com channel address (https://www.youtube.com/channel/... or /@handle)");
  if (v.channel_url && !v.channel_name) p("channel_name is required with channel_url");
  return { video: problems.length ? null : v, problems };
}

const posterOf = (v) => v.poster || (v.provider === "youtube" ? `https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg` : "");

/** Extra CSP sources the video needs: { frame, img }. Empty with no video. */
export function videoCsp(video) {
  const out = { frame: [], img: [] };
  if (video?.provider !== "youtube") return out;
  out.frame.push("https://www.youtube-nocookie.com");
  if (!video.poster) out.img.push("https://i.ytimg.com");
  return out;
}

/** Add the video's sources to a CSP string ("a 'self'; b 'self'; ..."). */
export function withVideoCsp(csp, video) {
  const extra = videoCsp(video);
  let out = csp;
  const add = (dir, srcs) => {
    if (!srcs.length) return;
    const re = new RegExp(`(^|;\\s*)(${dir}\\s[^;]*)`);
    out = re.test(out) ? out.replace(re, (_, pre, d) => `${pre}${d} ${srcs.join(" ")}`) : `${out}; ${dir} 'self' ${srcs.join(" ")}`;
  };
  add("frame-src", extra.frame);
  add("img-src", extra.img);
  return out;
}

/** The landing-page section. Empty string when there is no video. */
export function introVideo(video, { heading = "See how it works" } = {}) {
  if (!video) return "";
  const v = video;
  const poster = posterOf(v);
  let player;
  if (v.provider === "youtube") {
    const watch = `https://www.youtube.com/watch?v=${v.youtube_id}`;
    player = `<a class="video-facade" href="${esc(watch)}" rel="noopener" data-yt="${esc(v.youtube_id)}" data-yt-title="${esc(v.title)}">
    <img src="${esc(poster)}" alt="" width="1280" height="720" loading="lazy" decoding="async">
    <span class="video-play" aria-hidden="true"></span><span class="visually-hidden">Play video: ${esc(v.title)}</span></a>`;
  } else {
    player = `<video class="video-file" controls preload="metadata" playsinline poster="${esc(poster)}" width="1280" height="720">
    <source src="${esc(v.file)}" type="video/mp4">
    ${v.captions ? `<track kind="captions" src="${esc(v.captions)}" srclang="en" label="English" default>` : ""}
    <a href="${esc(v.file)}">Download the video</a></video>`;
  }
  return `<section class="band intro-video" aria-labelledby="intro-video-h"><div class="wrap">
  <h2 id="intro-video-h">${esc(v.heading || heading)}</h2>
  <div class="video-frame">${player}</div>
  <p class="video-caption">${esc(v.description)}</p>
  ${v.channel_url ? `<p class="video-channel"><a href="${esc(v.channel_url)}" rel="noopener">More videos on ${esc(v.channel_name)} on YouTube</a></p>` : ""}
</div></section>`;
}

/** schema.org VideoObject, so Google can show the video in search. */
export function videoJsonLd(video, origin) {
  if (!video) return null;
  const abs = (u) => (u.startsWith("/") ? origin + u : u);
  const ld = { "@context": "https://schema.org", "@type": "VideoObject", name: video.title, description: video.description,
    thumbnailUrl: abs(posterOf(video)), uploadDate: video.upload_date };
  if (video.duration) ld.duration = video.duration;
  if (video.provider === "youtube") ld.embedUrl = `https://www.youtube-nocookie.com/embed/${video.youtube_id}`;
  else ld.contentUrl = abs(video.file);
  return ld;
}
