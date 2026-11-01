// SiteGuard Education hub, on both SiteGuard websites (the same file lives in
// siteguard-website and SiteGuard-Forms-Storefront; keep them, and
// data/education.json, identical).
//
//   /education/          the series as tabs, and the latest videos
//   /education/<series>/ one series: About SiteGuard, How-tos, Toolbox talks,
//                        Inductions (data/education.json "groups")
//
// Every series has its tab and page from the start; one with no videos yet
// says so and points to the YouTube channel. Adding a video is pasting its
// YouTube link (youtube_url) with a title, description and the date it was
// published. Under each video: Watch on YouTube, Copy link (for a toolbox
// talk or an induction) and, when download_url is set, Download.
//
// Optional "modules" on a video (e.g. ["audit", "safety"]) tags it to product
// module pages; relatedVideos() gives those pages a "Related videos" band.
// Each site decides which module slugs it has; unknown tags are ignored.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";
import { checkVideo, normalizeVideo, videoPlayer, videoJsonLd, videoCsp } from "./video.mjs";

const CHANNEL_RE = /^https:\/\/(www\.)?youtube\.com\/(channel\/UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{3,30})\/?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const seriesPath = (slug) => `/education/${slug}/`;

export async function loadEducation(root) {
  const problems = [];
  let d;
  try { d = JSON.parse(await readFile(path.join(root, "data", "education.json"), "utf8")); } catch (e) {
    if (e.code !== "ENOENT") problems.push(`education.json: ${e.message}`);
    return { edu: null, problems };
  }
  if (!CHANNEL_RE.test(d.channel_url ?? "")) problems.push("education.json: channel_url must be the YouTube channel address");
  if (!d.channel_name) problems.push("education.json: channel_name is required");
  const groups = [];
  const slugs = new Set();
  for (const [gi, g] of (d.groups ?? []).entries()) {
    const where = `education.json ${g.title ?? `series #${gi + 1}`}`;
    if (!g.title) problems.push(`${where}: title is required`);
    if (!SLUG_RE.test(g.slug ?? "")) problems.push(`${where}: slug (lower-case letters, digits and dashes, for the page address) is required`);
    if (slugs.has(g.slug)) problems.push(`${where}: duplicate slug`);
    slugs.add(g.slug);
    const videos = [];
    for (const [vi, raw] of (g.videos ?? []).entries()) {
      const v = normalizeVideo(raw);
      const p = checkVideo(v);
      if (v.modules !== undefined && (!Array.isArray(v.modules) || v.modules.some((m) => !SLUG_RE.test(String(m))))) p.push("modules must be a list of module slugs (lower-case letters, digits and dashes)");
      for (const m of p) problems.push(`${where} video #${vi + 1}${raw?.title ? ` (${raw.title})` : ""}: ${m}`);
      if (!p.length) videos.push(v);
    }
    groups.push({ ...g, videos });
  }
  return { edu: { ...d, groups }, problems };
}

/** CSP sources for every video on the pages (YouTube ones need the player). */
export function educationCsp(edu) {
  const out = { frame: new Set(), img: new Set() };
  for (const g of edu?.groups ?? []) for (const v of g.videos) {
    const c = videoCsp(v);
    c.frame.forEach((x) => out.frame.add(x)); c.img.forEach((x) => out.img.add(x));
  }
  return { frame: [...out.frame], img: [...out.img] };
}

const watchUrl = (v) => (v.provider === "youtube" ? `https://www.youtube.com/watch?v=${v.youtube_id}` : "");

function card(v) {
  const watch = watchUrl(v);
  const actions = [
    watch && `<a class="btn btn-small" href="${esc(watch)}" rel="noopener">Watch on YouTube</a>`,
    watch && `<button class="btn btn-small" type="button" data-copy="${esc(watch)}">Copy link</button>`,
    v.download_url && `<a class="btn btn-small" href="${esc(v.download_url)}"${v.download_url.startsWith("/") ? " download" : ' rel="noopener"'}>Download</a>`,
  ].filter(Boolean).join("");
  return `<li class="edu-card">
    <div class="video-frame">${videoPlayer(v)}</div>
    <h3>${esc(v.title)}</h3><p>${esc(v.description)}</p>
    ${actions ? `<div class="edu-actions">${actions}</div>` : ""}
    ${watch ? `<p class="edu-link small">Link for your toolbox talk or induction: <a href="${esc(watch)}" rel="noopener">${esc(watch)}</a></p>` : ""}
  </li>`;
}

function tabs(edu, current) {
  return `<nav class="plan-states edu-tabs" aria-label="Video series"><ul>
  <li><a href="/education/"${current === null ? ' aria-current="page"' : ""}>All series</a></li>
  ${edu.groups.map((g) => `<li><a href="${seriesPath(g.slug)}"${g.slug === current ? ' aria-current="page"' : ""}>${esc(g.title)}${g.videos.length ? ` <span class="edu-count">${g.videos.length}</span>` : ""}</a></li>`).join("")}
</ul></nav>`;
}

const channelBand = (edu) => `<section class="band band-ink"><div class="wrap">
  <h2>Subscribe on YouTube</h2>
  <p class="lede">New how-tos, toolbox talks and inductions for Australian construction go up on the ${esc(edu.channel_name)} channel first.</p>
  <div class="btn-row"><a class="btn btn-hivis" href="${esc(edu.channel_url)}" rel="noopener">Subscribe on YouTube</a></div>
</div></section>`;

const usingNote = `<p class="small edu-use">Show a video in a toolbox talk or pre-start, or add its link to your site induction. Playing it through YouTube keeps your crews on the latest version.</p>`;

const empty = (edu) => `<div class="edu-empty"><p>No videos in this series yet.</p><p><a href="${esc(edu.channel_url)}" rel="noopener">Subscribe on YouTube</a> to get them as they are published.</p></div>`;

/** /education/: the tabs, each series with its newest videos. */
export function educationBody(edu) {
  const sections = edu.groups.map((g, gi) => `<section class="band${gi % 2 ? " band-grey" : ""}"><div class="wrap">
  <div class="edu-head"><h2><a href="${seriesPath(g.slug)}">${esc(g.title)}</a></h2>${g.videos.length > 2 ? `<a href="${seriesPath(g.slug)}">All ${g.videos.length} videos</a>` : ""}</div>
  ${g.intro ? `<p class="lede">${esc(g.intro)}</p>` : ""}
  ${g.videos.length ? `<ul class="edu-grid">${g.videos.slice(0, 2).map(card).join("")}</ul>` : empty(edu)}
</div></section>`).join("");
  return `<section class="band edu-top"><div class="wrap">${tabs(edu, null)}${usingNote}</div></section>
${sections}
${channelBand(edu)}`;
}

/** /education/<series>/: every video in one series. */
export function seriesBody(edu, slug) {
  const g = edu.groups.find((x) => x.slug === slug);
  return `<section class="band"><div class="wrap">
  ${tabs(edu, slug)}
  ${g.intro ? `<p class="lede">${esc(g.intro)}</p>` : ""}
  ${usingNote}
  ${g.videos.length ? `<ul class="edu-grid">${g.videos.map(card).join("")}</ul>` : empty(edu)}
</div></section>
${channelBand(edu)}`;
}

export function educationJsonLd(edu, origin, slug = null) {
  const vids = (slug ? edu.groups.filter((g) => g.slug === slug) : edu.groups).flatMap((g) => (slug ? g.videos : g.videos.slice(0, 2)));
  if (!vids.length) return null;
  const items = vids.map((v, i) => ({ "@type": "ListItem", position: i + 1, item: videoJsonLd(v, origin) }));
  for (const it of items) delete it.item["@context"];
  return { "@context": "https://schema.org", "@type": "ItemList", name: `${edu.channel_name} videos`, itemListElement: items };
}

/** Every video tagged with this module, newest first. */
export function videosForModule(edu, module) {
  const vids = (edu?.groups ?? []).flatMap((g) => g.videos.filter((v) => (v.modules ?? []).includes(module)));
  return vids.sort((a, b) => String(b.upload_date).localeCompare(String(a.upload_date)));
}

/** "Related videos" band for a module page, or "" when no video is tagged with it. */
export function relatedVideos(edu, module, { max = 4, heading = "Related videos" } = {}) {
  const vids = videosForModule(edu, module).slice(0, max);
  if (!vids.length) return "";
  return `<section class="band band-grey edu-related"><div class="wrap">
  <h2>${esc(heading)}</h2>
  <ul class="edu-grid">${vids.map(card).join("")}</ul>
  <p><a href="/education/">More on SiteGuard Education</a></p>
</div></section>`;
}
