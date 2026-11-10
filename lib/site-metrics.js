// S1 (overnight 8-9 Nov 2026; growth plan Rev02 M1, M2, M3, M9): the page tags
// and the campaign counts. Every one is OFF until its setting is in .env, and a
// setting that doesn't look right is ignored (and said so at start-up).
//
//   M1  CF_WEB_ANALYTICS_TOKEN      Cloudflare Web Analytics beacon (cookie-less)
//   M3  GOOGLE_SITE_VERIFICATION    Search Console <meta name="google-site-verification">
//   M9  GOOGLE_ADS_TAG=on           Google tag, and the checkout-success conversion;
//       GOOGLE_ADS_ID=AW-...        needs all three; sets Google's cookies, so it
//       GOOGLE_ADS_CONVERSION_LABEL stays off until the privacy policy covers it
//   M2  CAMPAIGN_COUNTS=on          count utm landings, enquiries and paid orders
//       CAMPAIGN_METRICS_TOKEN_SHA256  sha256 (hex) of the Console's service token;
//                                   GET /internal/metrics/campaigns answers only then
//
// The tags are added to the built pages as they are served (server side), so a
// change needs a restart, not a rebuild. Campaign counts follow the contract in
// siteguard-ai docs/METRICS_SETUP.md section 4: per day (Australia/Sydney) and
// utm_source / utm_medium / utm_campaign only. No IP, no cookie, no user agent,
// no visitor id, no URL. Nothing here sets a cookie.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const ON = (v) => ["on", "1", "true", "yes"].includes(String(v ?? "").trim().toLowerCase());

const CF_TOKEN_RE = /^[A-Za-z0-9]{20,64}$/;
const GSC_RE = /^[A-Za-z0-9_-]{10,120}$/;
const ADS_ID_RE = /^AW-\d{6,14}$/;
const ADS_LABEL_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

/** The tag and count settings from the environment, checked. `problems` lists
 *  what was set but ignored. Never holds a secret: the service token is a hash. */
export function metricsSettings(env = process.env) {
  const problems = [];
  const pick = (name, re) => {
    const v = String(env[name] ?? "").trim();
    if (!v) return "";
    if (!re.test(v)) { problems.push(`${name} doesn't look right, so it is ignored`); return ""; }
    return v;
  };
  const cfBeaconToken = pick("CF_WEB_ANALYTICS_TOKEN", CF_TOKEN_RE);
  const gscVerification = pick("GOOGLE_SITE_VERIFICATION", GSC_RE);
  const adsId = pick("GOOGLE_ADS_ID", ADS_ID_RE);
  const adsLabel = pick("GOOGLE_ADS_CONVERSION_LABEL", ADS_LABEL_RE);
  let adsOn = ON(env.GOOGLE_ADS_TAG);
  if (adsOn && !(adsId && adsLabel)) {
    problems.push("GOOGLE_ADS_TAG is on but GOOGLE_ADS_ID or GOOGLE_ADS_CONVERSION_LABEL is missing, so the Google tag stays off");
    adsOn = false;
  }
  const tokenSha256 = pick("CAMPAIGN_METRICS_TOKEN_SHA256", SHA256_RE).toLowerCase();
  return { cfBeaconToken, gscVerification, adsOn, adsId: adsOn ? adsId : "", adsLabel: adsOn ? adsLabel : "",
    countsOn: ON(env.CAMPAIGN_COUNTS), tokenSha256, problems };
}

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What goes before </head> on every served page; "" when every tag is off. */
export function headTags(s) {
  const out = [];
  // X2 (S6): the attribution script, only while campaign counts are on.
  if (s.countsOn) out.push(`<script src="/assets/attribution.js" defer></script>`);
  if (s.gscVerification) out.push(`<meta name="google-site-verification" content="${attr(s.gscVerification)}">`);
  if (s.cfBeaconToken) {
    out.push(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${attr(JSON.stringify({ token: s.cfBeaconToken }))}'></script>`);
  }
  if (s.adsOn) {
    out.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${attr(s.adsId)}"></script>`);
    out.push(`<script src="/metrics/gtag-init.js"></script>`);
  }
  return out.join("\n");
}

/** The Google tag's set-up, served same-origin (the CSP allows no inline script).
 *  The conversion fires once per paid session, on the order success page only. */
export function gtagInit(s) {
  const id = JSON.stringify(s.adsId);
  const sendTo = JSON.stringify(`${s.adsId}/${s.adsLabel}`);
  return `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag("js",new Date());gtag("config",${id});
if(location.pathname.indexOf("/order/success/")===0){var sid=new URLSearchParams(location.search).get("session_id")||"";var k="sg_conv_"+sid;var seen=false;try{seen=!!sessionStorage.getItem(k);}catch(e){}
if(sid&&!seen){gtag("event","conversion",{send_to:${sendTo}});try{sessionStorage.setItem(k,"1");}catch(e){}}}
`;
}

/** The CSP with what the switched-on tags need, and nothing when they're off. */
export function metricsCsp(csp, s) {
  const extra = { "script-src": [], "connect-src": [], "img-src": [], "frame-src": [] };
  if (s.cfBeaconToken) {
    extra["script-src"].push("https://static.cloudflareinsights.com");
    extra["connect-src"].push("https://cloudflareinsights.com");
  }
  if (s.adsOn) {
    extra["script-src"].push("https://www.googletagmanager.com");
    extra["connect-src"].push("https://www.google.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://www.googletagmanager.com");
    extra["img-src"].push("https://www.google.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://www.google.com.au");
    extra["frame-src"].push("https://td.doubleclick.net");
  }
  let out = csp;
  for (const [dir, srcs] of Object.entries(extra)) {
    const add = srcs.filter((x) => !out.includes(x));
    if (!add.length) continue;
    const re = new RegExp(`(^|;\\s*)(${dir}\\s[^;]*)`);
    out = re.test(out) ? out.replace(re, (_, pre, d) => `${pre}${d} ${add.join(" ")}`) : `${out}; ${dir} 'self' ${add.join(" ")}`;
  }
  return out;
}

// -- M2: campaign counts ---------------------------------------------------------------

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"];
/** X2 (S6): what the browser carries from the landing (assets/attribution.js), paired with
 *  the website (W10). Counts use the three UTM_KEYS; checkout metadata takes all six. */
export const ATTRIBUTION_KEYS = [...UTM_KEYS, "utm_term", "utm_content", "gclid"];
const MAX_RANGE_DAYS = 92;
const KEEP_DAYS = 400;

/** A utm value as stored: trimmed, lower case, at most 60 characters. Anything
 *  that looks like an email address or a phone number is dropped (stored as ""). */
export function cleanUtm(v) {
  const s = String(Array.isArray(v) ? v[0] : (v ?? "")).trim().toLowerCase().slice(0, 60);
  if (s.includes("@") || /\d[\d\s-]{7,}\d/.test(s)) return "";
  return s.replace(/[\u0000-\u001f|]/g, "");
}

/** The three utm values from a query, a form body or Stripe metadata, or null when none is set. */
export function utmFrom(obj) {
  if (!obj || typeof obj !== "object") return null;
  const u = Object.fromEntries(UTM_KEYS.map((k) => [k, cleanUtm(obj[k])]));
  return UTM_KEYS.some((k) => u[k]) ? u : null;
}

/** The six attribution values for Stripe metadata, cleaned (utm_* as cleanUtm; gclid
 *  letters, digits, - and _ only, at most 100). Empty values are left out; {} when none. */
export function attributionFrom(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of ATTRIBUTION_KEYS) {
    const raw = String(Array.isArray(obj[k]) ? obj[k][0] : (obj[k] ?? "")).trim();
    const v = k === "gclid" ? (/^[A-Za-z0-9_-]{1,100}$/.test(raw) ? raw : "") : cleanUtm(raw);
    if (v) out[k] = v;
  }
  return out;
}

/** Today in Australia/Sydney, YYYY-MM-DD. */
export function sydneyDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Counts in one small JSON file (var/campaign-counts.json), written atomically,
 *  one write at a time. Keyed date|source|medium|campaign; nothing else is kept. */
export function createCampaignCounter({ file, now = () => new Date() }) {
  let data = null;
  let queue = Promise.resolve();
  async function load() {
    if (data) return data;
    try { data = JSON.parse(await readFile(file, "utf8")); } catch { data = {}; }
    if (!data || typeof data !== "object" || !data.rows) data = { rows: {} };
    return data;
  }
  function bump(field, utm) {
    if (!utm) return Promise.resolve(false);
    const day = sydneyDate(now());
    queue = queue.then(async () => {
      const d = await load();
      const key = [day, utm.utm_source, utm.utm_medium, utm.utm_campaign].join("|");
      const row = d.rows[key] ?? { landings: 0, enquiries: 0, orders: 0 };
      row[field] += 1;
      d.rows[key] = row;
      const cutoff = sydneyDate(new Date(now().getTime() - KEEP_DAYS * 86400_000));
      for (const k of Object.keys(d.rows)) if (k.slice(0, 10) < cutoff) delete d.rows[k];
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(d), "utf8");
      await rename(tmp, file);
      return true;
    }).catch((err) => { console.error(`Campaign counts: not written (${err.message})`); data = null; return false; });
    return queue;
  }
  return {
    land: (utm) => bump("landings", utm),
    enquiry: (utm) => bump("enquiries", utm),
    order: (utm) => bump("orders", utm),
    async rows(from, to) {
      await queue;
      const d = await load();
      const out = [];
      for (const [k, r] of Object.entries(d.rows)) {
        const [date, utm_source, utm_medium, utm_campaign] = k.split("|");
        if (date < from || date > to) continue;
        const row = { date, utm_source, utm_medium, utm_campaign, landings: r.landings | 0, enquiries: r.enquiries | 0, orders: r.orders | 0 };
        if (row.landings || row.enquiries || row.orders) out.push(row);
      }
      return out.sort((a, b) => (a.date + a.utm_source + a.utm_medium + a.utm_campaign).localeCompare(b.date + b.utm_source + b.utm_medium + b.utm_campaign));
    },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /internal/metrics/campaigns for the Console (Bearer service token, checked by its
 *  sha256, constant time). 404 while no token hash is set; 401 with no detail on a bad token. */
export function campaignsRoute({ counter, tokenSha256, site = "storefront" }) {
  const want = tokenSha256 ? Buffer.from(tokenSha256, "hex") : null;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!want || !counter) return res.status(404).end();
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ""));
    const got = m ? createHash("sha256").update(m[1]).digest() : null;
    if (!got || got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).end();
    const { from, to } = req.query;
    if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to)) || from > to) {
      return res.status(400).json({ ok: false, reason: "from and to must be YYYY-MM-DD, from no later than to" });
    }
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1;
    if (!Number.isFinite(days) || days > MAX_RANGE_DAYS) {
      return res.status(400).json({ ok: false, reason: `ask for ${MAX_RANGE_DAYS} days or fewer` });
    }
    res.json({ site, as_of: new Date().toISOString(), rows: await counter.rows(String(from), String(to)) });
  };
}

/** Counts a landing: a page request (not /api, /assets, /internal, /metrics) whose
 *  query carries any utm value. Never blocks or changes the request. */
export function landingCounter(counter) {
  return (req, _res, next) => {
    if (req.method === "GET" && counter && !/^\/(api|assets|internal|metrics)(\/|$)/.test(req.path)) {
      const utm = utmFrom(req.query);
      if (utm) counter.land(utm);
    }
    next();
  };
}

/** Serves the built HTML pages with `snippet` added before </head>. Other files,
 *  and every page when the snippet is empty, are left to express.static as before. */
export function htmlWithTags(publicDir, snippet) {
  const root = path.resolve(publicDir);
  return async (req, res, next) => {
    if (!snippet || (req.method !== "GET" && req.method !== "HEAD")) return next();
    let rel;
    try { rel = decodeURIComponent(req.path); } catch { return next(); }
    if (rel.includes("\0") || /^\/(api|assets|internal|metrics)(\/|$)/.test(rel)) return next();
    const ext = path.extname(rel);
    const candidates = rel.endsWith("/") ? [`${rel}index.html`] : ext === ".html" ? [rel] : ext ? [] : [`${rel}.html`];
    for (const c of candidates) {
      const abs = path.resolve(root, `.${c}`);
      if (abs !== root && !abs.startsWith(root + path.sep)) return next();
      try {
        if (!(await stat(abs)).isFile()) continue;
        const html = await readFile(abs, "utf8");
        const i = html.indexOf("</head>");
        const body = i < 0 ? html : `${html.slice(0, i)}${snippet}\n${html.slice(i)}`;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=300");
        return req.method === "HEAD" ? res.end() : res.send(body);
      } catch { /* not there: try the next, then fall through to static */ }
    }
    next();
  };
}
