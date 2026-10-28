// SiteGuard Education hub (scripts/lib/education.mjs). Same file in both sites.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadEducation, educationBody, educationCsp, educationJsonLd } from "../scripts/lib/education.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = { provider: "youtube", youtube_id: "dQw4w9WgXcQ", title: "How to read a SWMS", description: "A short how-to.", upload_date: "2026-11-01" };
const D = (groups) => ({ channel_name: "SiteGuard Education", channel_url: "https://www.youtube.com/channel/UCegFXOpYr0-gWG0t0H4as1Q", groups });
async function fixture(d) {
  const root = await mkdtemp(path.join(tmpdir(), "edu-"));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/education.json"), JSON.stringify(d));
  return root;
}

test("empty groups are hidden; channel button and VideoObjects present", async () => {
  const { edu, problems } = await loadEducation(await fixture(D([{ title: "How-tos", videos: [V] }, { title: "Inductions", videos: [] }])));
  assert.deepEqual(problems, []);
  const html = educationBody(edu);
  assert.match(html, /<h2>How-tos<\/h2>/);
  assert.ok(!/Inductions<\/h2>/.test(html));
  assert.match(html, /href="https:\/\/www\.youtube\.com\/channel\/UCegFXOpYr0-gWG0t0H4as1Q" rel="noopener">Subscribe on YouTube/);
  assert.equal(educationJsonLd(edu, "https://x.example").itemListElement[0].item["@type"], "VideoObject");
  assert.deepEqual(educationCsp(edu).frame, ["https://www.youtube-nocookie.com"]);
});

test("a broken video or channel is reported and the video left out", async () => {
  const { edu, problems } = await loadEducation(await fixture({ ...D([{ title: "How-tos", videos: [{ ...V, youtube_id: "nope" }] }]), channel_url: "https://example.com" }));
  assert.ok(problems.some((m) => /channel_url/.test(m)));
  assert.ok(problems.some((m) => /youtube_id/.test(m)));
  assert.equal(edu.groups.length, 0);
});

test("this site's education.json is valid", async () => {
  const { edu, problems } = await loadEducation(ROOT);
  assert.deepEqual(problems, []);
  assert.ok(edu.groups.length > 0);
});
