// SiteGuard Education hub (/education/ on siteguardsystems.com.au). Videos are
// listed in data/education.json, grouped (how-tos, toolbox talks, inductions
// and so on); a group with no videos is not shown. Each video uses the same
// fields as data/intro-video.json (scripts/lib/video.mjs).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";
import { checkVideo, videoPlayer, videoJsonLd, videoCsp } from "./video.mjs";

const CHANNEL_RE = /^https:\/\/(www\.)?youtube\.com\/(channel\/UC[A-Za-z0-9_-]{22}|@[A-Za-z0-9._-]{3,30})\/?$/;

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
  for (const [gi, g] of (d.groups ?? []).entries()) {
    if (!g.title) problems.push(`education.json group #${gi + 1}: title is required`);
    const videos = [];
    for (const [vi, v] of (g.videos ?? []).entries()) {
      const p = checkVideo(v);
      for (const m of p) problems.push(`education.json ${g.title ?? `group #${gi + 1}`} video #${vi + 1}: ${m}`);
      if (!p.length) videos.push(v);
    }
    if (videos.length) groups.push({ ...g, videos });
  }
  return { edu: { ...d, groups }, problems };
}

/** CSP sources for every video on the page (YouTube ones need the player). */
export function educationCsp(edu) {
  const out = { frame: new Set(), img: new Set() };
  for (const g of edu?.groups ?? []) for (const v of g.videos) {
    const c = videoCsp(v);
    c.frame.forEach((x) => out.frame.add(x)); c.img.forEach((x) => out.img.add(x));
  }
  return { frame: [...out.frame], img: [...out.img] };
}

export function educationBody(edu) {
  const subscribe = `<a class="btn btn-hivis" href="${esc(edu.channel_url)}" rel="noopener">Subscribe on YouTube</a>`;
  const groups = edu.groups.map((g, gi) => `<section class="band${gi % 2 ? " band-grey" : ""}"><div class="wrap">
  <h2>${esc(g.title)}</h2>${g.intro ? `<p class="lede">${esc(g.intro)}</p>` : ""}
  <ul class="edu-grid">${g.videos.map((v) => `<li class="edu-card">
    <div class="video-frame">${videoPlayer(v)}</div>
    <h3>${esc(v.title)}</h3><p>${esc(v.description)}</p>
  </li>`).join("")}</ul>
</div></section>`).join("");
  return `${groups}
<section class="band band-ink"><div class="wrap">
  <h2>More on YouTube</h2>
  <p class="lede">How-tos, toolbox talks and inductions for Australian construction, on the ${esc(edu.channel_name)} channel.</p>
  <div class="btn-row">${subscribe}</div>
</div></section>`;
}

export function educationJsonLd(edu, origin) {
  const items = edu.groups.flatMap((g) => g.videos).map((v, i) => ({ "@type": "ListItem", position: i + 1, item: videoJsonLd(v, origin) }));
  for (const it of items) delete it.item["@context"];
  return { "@context": "https://schema.org", "@type": "ItemList", name: `${edu.channel_name} videos`, itemListElement: items };
}
