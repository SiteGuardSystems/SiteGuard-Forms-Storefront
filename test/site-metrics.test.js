// S1 (8-9 Nov 2026): page tags (M1 beacon, M3 Search Console, M9 Google tag) and
// campaign counts (M2), all off until set. No network: the tags are only checked
// in the served HTML and the CSP.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";
import { createApp, CSP } from "../lib/create-app.js";
import {
  metricsSettings, headTags, metricsCsp, cleanUtm, utmFrom, sydneyDate, createCampaignCounter, attributionFrom, ATTRIBUTION_KEYS,
} from "../lib/site-metrics.js";

// Made at run time, so nothing key-like sits in the file.
const BEACON = "b".repeat(32);
const GSC = "verify_" + "x".repeat(20);
const SERVICE = ["test", "campaign", "token"].join("-");
const SERVICE_SHA = createHash("sha256").update(SERVICE).digest("hex");

const PAGE = "<!doctype html><html><head><title>t</title></head><body>hi</body></html>";

async function withApp({ env = {}, counts = false, now } = {}, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sf-metrics-"));
  const pub = path.join(dir, "dist");
  await mkdir(path.join(pub, "order", "success"), { recursive: true });
  await mkdir(path.join(pub, "assets"), { recursive: true });
  await writeFile(path.join(pub, "index.html"), PAGE);
  await writeFile(path.join(pub, "about.html"), PAGE);
  await writeFile(path.join(pub, "order", "success", "index.html"), PAGE);
  await writeFile(path.join(pub, "404.html"), PAGE);
  await writeFile(path.join(pub, "assets", "a.css"), "body{}");
  await writeFile(path.join(dir, "secret.html"), "<html><head></head>outside</html>");
  const catalogPath = path.join(dir, "catalogue.json");
  await writeFile(catalogPath, JSON.stringify({ schema: 1, preview: false, currency: "AUD", packs: [], documents: [] }));
  const varDir = path.join(dir, "var");
  const metrics = metricsSettings(env);
  const campaignCounter = counts ? createCampaignCounter({ file: path.join(varDir, "campaign-counts.json"), ...(now ? { now } : {}) }) : null;
  const app = createApp({
    catalogPath, varDir, publicDir: pub, stripe: null, publicOrigin: "http://localhost:4300",
    mailer: { configured: false, send: async () => ({ ok: false }) },
    leadAllowedOrigins: [], metrics, campaignCounter,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, varDir, metrics });
  } finally {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

describe("site tags: off until set", () => {
  test("nothing set: pages, CSP and routes are exactly as before", async () => {
    await withApp({}, async ({ base }) => {
      const r = await fetch(base + "/");
      const html = await r.text();
      assert.equal(html, PAGE);
      assert.equal(r.headers.get("content-security-policy"), CSP);
      assert.equal((await fetch(base + "/metrics/gtag-init.js")).status, 404);
      assert.equal((await fetch(base + "/internal/metrics/campaigns?from=2026-11-01&to=2026-11-08")).status, 404);
    });
  });

  test("M1 beacon and M3 meta tag go into every page, with the CSP for the beacon only", async () => {
    await withApp({ env: { CF_WEB_ANALYTICS_TOKEN: BEACON, GOOGLE_SITE_VERIFICATION: GSC } }, async ({ base }) => {
      for (const p of ["/", "/about", "/about.html", "/order/success/"]) {
        const r = await fetch(base + p);
        const html = await r.text();
        assert.equal(r.status, 200, p);
        assert.match(html, new RegExp(`<meta name="google-site-verification" content="${GSC}">`), p);
        assert.match(html, /<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js" data-cf-beacon='\{&quot;token&quot;:&quot;b{32}&quot;\}'><\/script>\n<\/head>/, p);
        assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
        const csp = r.headers.get("content-security-policy");
        assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
        assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com/);
        assert.doesNotMatch(csp, /googletagmanager/);
      }
      assert.equal(await (await fetch(base + "/assets/a.css")).text(), "body{}");
      assert.equal((await fetch(base + "/metrics/gtag-init.js")).status, 404);
    });
  });

  test("a page outside dist/ is never read", async () => {
    await withApp({ env: { GOOGLE_SITE_VERIFICATION: GSC } }, async ({ base }) => {
      for (const p of ["/../secret.html", "/%2e%2e/secret.html", "/..%2fsecret.html"]) {
        const html = await (await fetch(base + p)).text();
        assert.doesNotMatch(html, /outside/, p);
      }
    });
  });

  test("a setting that doesn't look right is ignored and reported", () => {
    const s = metricsSettings({ CF_WEB_ANALYTICS_TOKEN: "<script>", GOOGLE_SITE_VERIFICATION: 'a" onload="x', GOOGLE_ADS_TAG: "on" });
    assert.equal(headTags(s), "");
    assert.equal(s.adsOn, false);
    assert.equal(s.problems.length, 3);
    assert.equal(metricsCsp(CSP, s), CSP);
  });

  test("M9 Google tag: off by default, and on only with the ID and the label", async () => {
    assert.equal(metricsSettings({ GOOGLE_ADS_ID: "AW-123456789", GOOGLE_ADS_CONVERSION_LABEL: "abcDEF12" }).adsOn, false);
    const env = { GOOGLE_ADS_TAG: "on", GOOGLE_ADS_ID: "AW-123456789", GOOGLE_ADS_CONVERSION_LABEL: "abcDEF12" };
    await withApp({ env }, async ({ base }) => {
      const r = await fetch(base + "/");
      const html = await r.text();
      assert.match(html, /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=AW-123456789"><\/script>/);
      assert.match(html, /<script src="\/metrics\/gtag-init\.js"><\/script>/);
      assert.match(r.headers.get("content-security-policy"), /script-src 'self' https:\/\/www\.googletagmanager\.com/);
      const js = await (await fetch(base + "/metrics/gtag-init.js")).text();
      assert.match(js, /gtag\("config","AW-123456789"\)/);
      assert.match(js, /location\.pathname\.indexOf\("\/order\/success\/"\)===0/);
      assert.match(js, /send_to:"AW-123456789\/abcDEF12"/);
      assert.match(js, /sessionStorage/);   // once per paid session, no cookie of ours
      assert.doesNotMatch(js, /document\.cookie/);
    });
  });
});

describe("M2 campaign counts", () => {
  test("utm values are cleaned; anything like an email or phone number is dropped", () => {
    assert.equal(cleanUtm("  LinkedIn "), "linkedin");
    assert.equal(cleanUtm("x".repeat(80)).length, 60);
    assert.equal(cleanUtm("dan@example.com"), "");
    assert.equal(cleanUtm("0400 123 456"), "");
    assert.equal(cleanUtm(["a", "b"]), "a");
    assert.equal(utmFrom({ ref: "x" }), null);
    assert.deepEqual(utmFrom({ utm_source: "LinkedIn" }), { utm_source: "linkedin", utm_medium: "", utm_campaign: "" });
    assert.equal(sydneyDate(new Date("2026-11-08T14:30:00Z")), "2026-11-09");   // 1:30 am in Sydney
  });

  test("landings, enquiries and orders are counted per day and utm only, and nothing else is kept", async () => {
    const fixed = () => new Date("2026-11-08T02:00:00Z");
    await withApp({ counts: true, now: fixed, env: { CAMPAIGN_METRICS_TOKEN_SHA256: SERVICE_SHA } }, async ({ base, varDir }) => {
      await fetch(base + "/?utm_source=LinkedIn&utm_medium=social&utm_campaign=launch&gclid=abc");
      await fetch(base + "/about?utm_source=linkedin&utm_medium=social&utm_campaign=launch");
      await fetch(base + "/");                                   // no utm: not counted
      await fetch(base + "/api/health?utm_source=x");             // not a page: not counted
      await fetch(base + "/api/lead", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dan", email: "delivered@resend.dev", utm_source: "linkedin", utm_medium: "social", utm_campaign: "launch" }) });
      await fetch(base + "/api/lead", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Dan", email: "delivered@resend.dev" }) });   // no utm: not counted
      const raw = await readFile(path.join(varDir, "campaign-counts.json"), "utf8");
      assert.deepEqual(JSON.parse(raw), { rows: { "2026-11-08|linkedin|social|launch": { landings: 2, enquiries: 1, orders: 0 } } });
      for (const leak of ["127.0.0.1", "delivered@resend.dev", "abc", "Dan", "about", "Mozilla", "node"]) assert.ok(!raw.includes(leak), leak);

      const ask = (q, auth = `Bearer ${SERVICE}`) => fetch(base + `/internal/metrics/campaigns${q}`, { headers: auth ? { Authorization: auth } : {} });
      const ok = await ask("?from=2026-11-01&to=2026-11-08");
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("cache-control"), "no-store");
      const body = await ok.json();
      assert.equal(body.site, "storefront");
      assert.ok(body.as_of);
      assert.deepEqual(body.rows, [{ date: "2026-11-08", utm_source: "linkedin", utm_medium: "social", utm_campaign: "launch", landings: 2, enquiries: 1, orders: 0 }]);
      assert.deepEqual((await (await ask("?from=2026-11-09&to=2026-11-10")).json()).rows, []);
      const no = await ask("?from=2026-11-01&to=2026-11-08", "Bearer wrong");
      assert.equal(no.status, 401);
      assert.equal(await no.text(), "");
      assert.equal((await ask("?from=2026-11-01&to=2026-11-08", null)).status, 401);
      assert.equal((await ask("?from=2026-01-01&to=2026-11-08")).status, 400);   // over 92 days
      assert.equal((await ask("?from=2026-11-08&to=2026-11-01")).status, 400);
      assert.equal((await ask("?from=yesterday&to=2026-11-01")).status, 400);
    });
  });

  test("counting on but no token hash: the Console read answers 404", async () => {
    await withApp({ counts: true }, async ({ base }) => {
      const r = await fetch(base + "/internal/metrics/campaigns?from=2026-11-01&to=2026-11-08", { headers: { Authorization: `Bearer ${SERVICE}` } });
      assert.equal(r.status, 404);
    });
  });

  test("counting off: a utm landing writes nothing", async () => {
    await withApp({}, async ({ base, varDir }) => {
      await fetch(base + "/?utm_source=linkedin");
      await assert.rejects(readFile(path.join(varDir, "campaign-counts.json"), "utf8"));
    });
  });
});

// X2 (S6, 10 Nov 2026): the attribution pair with the website (W10). Same keys, same
// storage key ("sg_attribution", sessionStorage), same tests.
describe("X2 attribution", () => {
  test("the six carried keys", () => {
    assert.deepEqual(ATTRIBUTION_KEYS, ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid"]);
  });

  test("the script is on the pages only while campaign counts are on", () => {
    assert.equal(headTags(metricsSettings({})), "");
    assert.match(headTags(metricsSettings({ CAMPAIGN_COUNTS: "on" })), /<script src="\/assets\/attribution\.js" defer><\/script>/);
  });

  test("attributionFrom cleans for Stripe metadata and keeps nothing personal", () => {
    assert.deepEqual(attributionFrom({ utm_source: "LinkedIn", gclid: "abc-_1", utm_term: "0412 345 678", utm_content: "x@y.au", other: "z" }),
      { utm_source: "linkedin", gclid: "abc-_1" });
    assert.deepEqual(attributionFrom({ gclid: "<script>" }), {});
    assert.deepEqual(attributionFrom(null), {});
  });

  /** Runs public/assets/attribution.js against a fake page. */
  async function runScript({ search = "", stored = null, forms = 1 } = {}) {
    const src = await readFile(new URL("../public/assets/attribution.js", import.meta.url), "utf8");
    const store = new Map(stored ? [["sg_attribution", stored]] : []);
    const made = [];
    const form = () => {
      const kids = [];
      return { kids, appendChild: (i) => (kids.push(i), i), querySelector: (sel) => kids.find((i) => sel.includes(`"${i.name}"`)) ?? null };
    };
    const fs = Array.from({ length: forms }, form);
    const window = {
      location: { search },
      sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    };
    const document = {
      readyState: "complete",
      querySelectorAll: (sel) => (sel === "[data-lead-form]" ? fs : []),
      createElement: () => { const i = {}; made.push(i); return i; },
      addEventListener: () => {},
    };
    vm.runInNewContext(src, { window, document, URLSearchParams });
    // The script's objects come from another realm: compare them as plain JSON.
    const attribution = () => JSON.parse(JSON.stringify(window.sgAttribution()));
    return { attribution, store, forms: fs };
  }

  test("keeps the landing's values for the visit and adds hidden fields to enquiry forms", async () => {
    const { attribution, store, forms } = await runScript({ search: "?utm_source=google&utm_campaign=swms&gclid=Cj0&x=1", forms: 2 });
    assert.deepEqual(JSON.parse(store.get("sg_attribution")), { utm_source: "google", utm_campaign: "swms", gclid: "Cj0" });
    assert.deepEqual(attribution(), { utm_source: "google", utm_campaign: "swms", gclid: "Cj0" });
    for (const f of forms) {
      assert.deepEqual(f.kids.map((i) => [i.type, i.name, i.value]),
        [["hidden", "utm_source", "google"], ["hidden", "utm_campaign", "swms"], ["hidden", "gclid", "Cj0"]]);
    }
  });

  test("the first landing in the visit wins", async () => {
    const { attribution } = await runScript({ search: "?utm_source=bing", stored: JSON.stringify({ utm_source: "google" }) });
    assert.deepEqual(attribution(), { utm_source: "google" });
  });

  test("no params: nothing stored and no fields added", async () => {
    const { attribution, store, forms } = await runScript({ search: "?ref=abc" });
    assert.equal(store.size, 0);
    assert.deepEqual(attribution(), {});
    assert.equal(forms[0].kids.length, 0);
  });

  test("no cookie and no localStorage", async () => {
    const src = await readFile(new URL("../public/assets/attribution.js", import.meta.url), "utf8");
    const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join(" ");
    assert.doesNotMatch(code, /document\.cookie|localStorage/);
  });
});
