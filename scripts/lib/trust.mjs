// Partners, affiliates and the Google review link: shared by both SiteGuard
// websites (the same file lives in siteguard-website and
// SiteGuard-Forms-Storefront; keep them identical).
//
// Data, not hand-written HTML:
//   data/partners.json        partners and affiliates. Written by the CRM
//                             (siteguard-ai: `python -m siteguard_org partners
//                             export-sites`) or edited by hand.
//   data/google-reviews.json  the Google Business Profile links (place_id,
//                             profile_url, review_url, write_review_url), written
//                             by siteguard-ai `partners export-sites`. Links only.
// Styles: the "partners, affiliates and Google reviews" block in each site's
// stylesheet.
//
// Nothing renders until there is something real to show: no partner section
// without a partner, and no Google link without the profile link.
//
// Google reviews (Dan, 8 Nov 2026, overnight decision N3): the sites show a
// "See our reviews on Google" link to the Business Profile, and the printed QR
// card asks for reviews. No rating, review count or review text is ever shown:
// a typed-in number goes stale and can't be checked here, and showing only some
// reviews risks misleading people (Australian Consumer Law). Any rating left in
// an old google-reviews.json is ignored.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { esc } from "./md.mjs";

export const SITES = ["systems", "forms"];
export const KINDS = { partner: "Partner", affiliate: "Affiliate" };
// Who pays whom when a referral turns into work. Drives the label on each
// listing and the link's rel (Google asks for rel="sponsored" on paid links).
export const FEES = {
  none: "",
  we_receive: "SiteGuard may receive a referral fee",
  we_pay: "SiteGuard may pay this partner a referral fee",
  both: "Referral fees may apply both ways",
};
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,23}$/;
const LOGO_RE = /^\/assets\/partners\/[a-z0-9][a-z0-9-]*\.(png|svg|webp|jpg)$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;
const GOOGLE_URL_RE = /^https:\/\/(www\.)?(google\.[a-z.]+|share\.google|g\.page|maps\.app\.goo\.gl|search\.google\.com)\/[^\s"<>]*$/;

/** Read and check the data for one site. `sample` reads the *.sample.json
 *  files instead, for a preview build only (a production build refuses it). */
export async function loadTrust(root, site, { sample = false } = {}) {
  const problems = [];
  const read = async (name, fallback) => {
    const file = path.join(root, "data", sample ? name.replace(/\.json$/, ".sample.json") : name);
    try { return JSON.parse(await readFile(file, "utf8")); } catch (e) {
      if (e.code !== "ENOENT") problems.push(`${path.basename(file)}: ${e.message}`);
      return fallback;
    }
  };
  const pdata = await read("partners.json", { partners: [] });
  const reviews = await read("google-reviews.json", {});
  const seen = new Set();
  const partners = [];
  for (const [i, p] of (pdata.partners ?? []).entries()) {
    const where = `partners.json #${i + 1}${p?.name ? ` (${p.name})` : ""}`;
    if (!p || typeof p !== "object") { problems.push(`${where}: not an object`); continue; }
    if (p.active === false) continue;
    const sites = p.sites ?? SITES;
    if (!Array.isArray(sites) || sites.some((s) => !SITES.includes(s))) problems.push(`${where}: sites must be a list of ${SITES.join(", ")}`);
    if (!sites.includes(site)) continue;
    if (!p.name || typeof p.name !== "string") problems.push(`${where}: name is required`);
    if (!KINDS[p.kind]) problems.push(`${where}: kind must be ${Object.keys(KINDS).join(" or ")}`);
    if (!/^https:\/\/[^\s"<>]+$/.test(p.url ?? "")) problems.push(`${where}: url must be an https:// address`);
    if (p.logo && !LOGO_RE.test(p.logo)) problems.push(`${where}: logo must be a file in /assets/partners/ (the CSP allows local images only)`);
    if (!(p.fee in FEES)) problems.push(`${where}: fee must be one of ${Object.keys(FEES).join(", ")}`);
    if ((p.blurb ?? "").length > 240) problems.push(`${where}: blurb is over 240 characters`);
    if (p.ref_code && !REF_RE.test(p.ref_code)) problems.push(`${where}: ref_code must be 2-24 letters, digits or dashes`);
    const id = (p.id ?? p.name ?? "").toLowerCase();
    if (seen.has(id)) problems.push(`${where}: duplicate partner`);
    seen.add(id);
    partners.push(p);
  }
  partners.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "partner" ? -1 : 1) || (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));

  const r = reviews ?? {};
  if (r.place_id && !PLACE_ID_RE.test(r.place_id)) problems.push("google-reviews.json: place_id doesn't look like a Google Place ID");
  for (const k of ["profile_url", "review_url", "write_review_url"]) {
    if (r[k] && !GOOGLE_URL_RE.test(r[k])) problems.push(`google-reviews.json: ${k} must be a Google address`);
  }
  // Links only (N3): nothing else from the file is kept, so nothing else can render.
  const links = {};
  for (const k of ["place_id", "profile_url", "review_url", "write_review_url"]) {
    if (typeof r[k] === "string" && r[k] && (k === "place_id" ? PLACE_ID_RE.test(r[k]) : GOOGLE_URL_RE.test(r[k]))) links[k] = r[k];
  }
  return { site, partners, reviews: links, problems, sample };
}

const rel = (p) => (p.fee && p.fee !== "none" ? "sponsored noopener" : "noopener");

function logoOrName(p) {
  return p.logo
    ? `<img src="${esc(p.logo)}" alt="${esc(p.name)}" loading="lazy" width="160" height="56">`
    : `<span class="partner-name">${esc(p.name)}</span>`;
}

/** The strip that sits above the footer on every page. Empty until there is
 *  at least one partner or affiliate for this site. */
export function partnerStrip(t) {
  if (!t.partners.length) return "";
  const shown = t.partners.slice(0, 8);
  return `<section class="band partners-strip" aria-labelledby="partners-strip-h"><div class="wrap">
  <div class="partners-strip-head"><h2 id="partners-strip-h">Partners and affiliates</h2><a href="/partners/">All partners and how referrals work</a></div>
  <ul class="partner-logos">${shown.map((p) => `<li><a href="${esc(p.url)}" rel="${rel(p)}">${logoOrName(p)}<span class="partner-cat">${esc(p.category ?? KINDS[p.kind])}</span></a></li>`).join("")}</ul>
</div></section>`;
}

/** "See our reviews on Google": a link to the Google Business Profile, where
 *  every review is. Empty until the profile link is exported. Never a rating,
 *  a count or review text (N3, 8 Nov 2026). */
export function reviewBadge(t, { compact = false } = {}) {
  const profile = t.reviews?.profile_url ?? "";
  if (!profile) return "";
  const link = `<a class="review-link" href="${esc(profile)}" rel="noopener">See our reviews on Google</a>`;
  return compact ? `<div class="review-compact">${link}</div>` : `<div class="review-block">${link}</div>`;
}

function partnerCards(list) {
  return `<ul class="partner-cards">${list.map((p) => `<li class="partner-card">
    ${p.logo ? `<div class="partner-card-logo">${logoOrName(p)}</div>` : ""}
    <div><h3>${esc(p.name)}</h3>${p.category ? `<p class="partner-cat">${esc(p.category)}</p>` : ""}
    ${p.blurb ? `<p>${esc(p.blurb)}</p>` : ""}
    <p><a href="${esc(p.url)}" rel="${rel(p)}">Visit ${esc(p.name)}</a></p>
    ${FEES[p.fee] ? `<p class="small fee-note">${FEES[p.fee]}.</p>` : ""}</div>
  </li>`).join("")}</ul>`;
}

/** The partner enquiry form. Posts to the same /api/lead as the contact form,
 *  marked as a partner enquiry so the CRM files it as an application. */
export function partnerForm({ source, endpoint }) {
  const ep = endpoint ? ` data-endpoint="${esc(endpoint)}"` : "";
  return `<form class="form" data-lead-form data-source="${source}"${ep} method="post" action="${esc(endpoint || "/api/lead")}" novalidate>
  <input type="hidden" name="source" value="${source}">
  <input type="hidden" name="enquiry_type" value="partner">
  <input type="hidden" name="ref" value="" data-ref-field>
  <label>Your name<input name="name" autocomplete="name" required maxlength="200"></label>
  <label>Email<input type="email" name="email" autocomplete="email" required maxlength="200"></label>
  <label>Business name<input name="company" autocomplete="organization" maxlength="200"></label>
  <label>Phone<input type="tel" name="phone" autocomplete="tel" maxlength="40"></label>
  <label>Your website<input type="url" name="partner_url" inputmode="url" maxlength="200" placeholder="https://"></label>
  <label>How would you like to work together?<select name="partner_kind">
    <option value="referral">Referral partner (we refer clients to each other)</option>
    <option value="affiliate">Affiliate (you list or link to SiteGuard)</option>
    <option value="alliance">Supplier or service alliance</option></select></label>
  <label>Tell us about your business and clients<textarea name="need" maxlength="2000" required></textarea></label>
  <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <p class="small">We use these details only to reply to you and, if we agree to work together, to manage the partnership. <a href="/legal/privacy/">Privacy Policy</a>.</p>
  <p class="form-status" data-status aria-live="polite"></p>
  <div><button class="btn btn-hivis" type="submit">Send partner enquiry</button></div>
</form>`;
}

/** The body of /partners/ (the page head is the site's own). */
export function partnersBody(t, { source, endpoint, brand }) {
  const partners = t.partners.filter((p) => p.kind === "partner");
  const affiliates = t.partners.filter((p) => p.kind === "affiliate");
  const list = t.partners.length
    ? `${partners.length ? `<h2>Partners</h2><p class="lede">Businesses we work alongside and refer clients to, and who refer clients to us.</p>${partnerCards(partners)}` : ""}
${affiliates.length ? `<h2 class="mt-lg">Affiliates</h2><p class="lede">Products and services we link to because they're useful to the people we work with.</p>${partnerCards(affiliates)}` : ""}`
    : `<h2>Partners</h2><p>We're building our partner network now. If your business works with Australian builders, subcontractors or HSEQ consultants, we'd like to hear from you.</p>`;
  return `<section class="band"><div class="wrap">${list}</div></section>
<section class="band band-grey"><div class="wrap cols">
  <div><h2>How referrals work</h2><ul>
    <li>We refer a client to a partner only when the partner fits the work, and we tell the client about any referral fee before they decide.</li>
    <li>Where ${esc(brand)} receives or pays a referral fee, the listing above says so.</li>
    <li>We share a client's details with a partner only with that client's permission.</li>
    <li>A listing here is not an approval of a partner's services. Check that a partner suits your work before you engage them.</li>
    <li>Partners and affiliates don't change what we recommend: our advice is based on your work and your obligations.</li></ul>
    ${reviewBadge(t)}</div>
  <div><h2>Become a partner</h2><p>Brokers, consultants, trainers, suppliers and software providers who work with Australian construction businesses. Tell us about your business and how you'd like to work together; we reply within one business day.</p>
    ${partnerForm({ source, endpoint })}</div>
</div></section>`;
}
