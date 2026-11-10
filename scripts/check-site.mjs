// S7 (overnight 10-11 Nov 2026): a check over the built site (dist/), after the build.
//   node scripts/check-site.mjs [dist]
// 1. Every internal link resolves: href and src values starting "/" (query and fragment
//    dropped) must be a file in dist/, a page (dir/index.html or .html), or a server
//    route (/api/..., /internal/..., /metrics/...).
// 2. Every page carries the SiteGuard lockup in its header: the shield mark and the
//    wordmark, linking home (the master lockup, Dan 2 Nov 2026).
// 3. No page loops back to itself: a link in the page body (outside the header, nav,
//    breadcrumbs and footer) whose target is the page's own URL.
// Exit 1 and a list when anything fails; nothing is fixed here.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_ROUTES = /^\/(api|internal|metrics)(\/|$)/;

async function files(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await files(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/** The page URL a built file is served at ("about/index.html" -> "/about/"). */
export const urlOf = (rel) => "/" + rel.replace(/(^|\/)index\.html$/, "$1");

/** Strips the header, nav, breadcrumbs and footer: what's left is the page body. */
export const bodyOf = (html) => html
  .replace(/<header[\s\S]*?<\/header>/gi, " ")
  .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
  .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
  .replace(/<head[\s\S]*?<\/head>/gi, " ");

export async function checkSite(dist) {
  const all = await files(dist);
  const have = new Set(all.map((f) => "/" + f));
  const resolves = (href) => {
    if (SERVER_ROUTES.test(href)) return true;
    if (have.has(href)) return true;
    if (href.endsWith("/") && have.has(href + "index.html")) return true;
    if (!path.extname(href) && (have.has(href + ".html") || have.has(href + "/index.html"))) return true;
    return false;
  };
  const problems = [];
  for (const rel of all.filter((f) => f.endsWith(".html"))) {
    const html = await readFile(path.join(dist, rel), "utf8");
    const url = urlOf(rel);
    for (const [, attr, raw] of html.matchAll(/\s(href|src)="(\/[^"]*)"/g)) {
      if (raw.startsWith("//")) continue;
      const href = raw.replace(/[?#].*$/, "");
      if (href && !resolves(href)) problems.push(`${url}: broken ${attr} ${raw}`);
    }
    const header = /<header[\s\S]*?<\/header>/i.exec(html)?.[0] ?? "";
    if (!/<a class="brand" href="\/"[^>]*>\s*<img src="\/assets\/shield\.png"[^>]*>\s*<span class="brand-name">SiteGuard <b>FORMS<\/b><\/span>/.test(header))
      problems.push(`${url}: no SiteGuard lockup (shield and wordmark, linking home) in the header`);
    if (!/^\/(404|500)\.html$/.test(url)) {
      for (const [, raw] of bodyOf(html).matchAll(/<a\s[^>]*href="([^"]*)"/g)) {
        const target = raw.replace(/[?#].*$/, "");
        if (raw.startsWith("#") || !target) continue;
        if (target === url || target + "/" === url) problems.push(`${url}: a body link loops back to the page itself (${raw})`);
      }
    }
  }
  return { pages: all.filter((f) => f.endsWith(".html")).length, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
  await stat(dist);
  const { pages, problems } = await checkSite(dist);
  for (const p of problems) console.log(`  ${p}`);
  console.log(`check-site: ${pages} page(s), ${problems.length} problem(s).`);
  if (problems.length) process.exit(1);
}
