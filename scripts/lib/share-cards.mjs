// FORMS queue S12: share cards (Open Graph and Twitter) for the pack and trade
// pages. One 1200x630 PNG per trade page and per range page, made by
// scripts/make-share-cards.mjs and committed under public/assets/og/. Each
// shows the SiteGuard FORMS lockup, the trade or range, and the levels. Never a
// price.
//
// cardsFor(cat, model) lists the cards the shop needs; the build's page() looks
// a page's card up by URL. A page without its own card uses the default card.
// The og:url carries utm tags so a shared link is counted as social; the
// <link rel="canonical"> stays clean.
import { groups, LEVEL_LABEL } from "./shop.mjs";

export const CARD_W = 1200;
export const CARD_H = 630;
export const CARD_DIR = "assets/og";
export const DEFAULT_CARD = { file: "default.png", title: "SiteGuard FORMS", line: "HSEQ documents for Australian construction", sub: "SWMS, ITPs, plans, forms and registers" };

const RANGE_LINES = {
  "trade-packs": "SWMS, safety plans and ITPs for your trade",
  "specialist-packs": "Packs for specialist trades and work types",
  "builder-packs": "For builders running the whole site",
  "management-systems": "Management-system documents",
};

/** The share cards the shop's pages need, keyed by page URL. */
export function cardsFor(cat, model) {
  const G = groups("");
  const cards = new Map();
  for (const t of model.trades) {
    const meta = G[t.group];
    if (!meta) continue;
    const levels = t.packs.map((p) => LEVEL_LABEL[p.level]).filter(Boolean);
    cards.set(`${meta.path}${t.slug}/`, {
      file: `${t.group === "specialist-packs" ? "specialist" : "trade"}-${t.slug}.png`,
      title: `${t.name} packs`,
      line: t.group === "specialist-packs" ? "Specialist SWMS, safety plans and ITPs" : "SWMS, safety plans and ITPs",
      sub: levels.join(" · "),
    });
  }
  for (const g of Object.keys(RANGE_LINES)) {
    const meta = G[g];
    if (!model.inGroup(g).length && !model.trades.some((t) => t.group === g)) continue;
    cards.set(meta.path, { file: `range-${g}.png`, title: meta.title, line: RANGE_LINES[g], sub: "Domestic · Light Commercial · Heavy Commercial" });
  }
  return cards;
}

/** og:url with utm tags for a shared link (the canonical link stays clean). */
export function shareUrl(origin, url) {
  const slug = url.replace(/^\/|\/$/g, "").replace(/\//g, "-") || "home";
  return `${origin}${url}?utm_source=social&utm_medium=share&utm_campaign=${encodeURIComponent(slug)}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The card's HTML, for the renderer. Fonts and the shield are the site's own. */
export function cardHtml(card, { assetsUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Barlow Condensed"; font-weight: 700; src: url("${assetsUrl}/fonts/barlow-condensed-latin-700-normal.woff2") format("woff2"); }
@font-face { font-family: "Barlow Condensed"; font-weight: 600; src: url("${assetsUrl}/fonts/barlow-condensed-latin-600-normal.woff2") format("woff2"); }
@font-face { font-family: "Barlow"; font-weight: 400; src: url("${assetsUrl}/fonts/barlow-latin-400-normal.woff2") format("woff2"); }
html, body { margin: 0; width: ${CARD_W}px; height: ${CARD_H}px; }
body { background: #2B2A2F; color: #fff; font-family: "Barlow", sans-serif; overflow: hidden; box-sizing: border-box;
  border-left: 24px solid #FB811C; padding: 64px 88px 70px 64px; display: flex; flex-direction: column; }
.lockup { display: flex; align-items: center; gap: 20px; }
.lockup img { height: 76px; }
.lockup span { font-family: "Barlow Condensed"; font-weight: 700; font-size: 46px; letter-spacing: 0.02em; }
.lockup b { color: #FB811C; font-weight: 700; }
.main { margin-top: auto; margin-bottom: auto; }
h1 { margin: 0 0 18px; font-family: "Barlow Condensed"; font-weight: 700; font-size: ${card.title.length > 26 ? 76 : 92}px; line-height: 1.02; }
.line { font-size: 38px; color: #E8E6EC; }
.sub { font-family: "Barlow Condensed"; font-weight: 600; font-size: 40px; color: #FB811C; }
</style></head><body>
<div class="lockup"><img src="${assetsUrl}/shield.png" alt=""><span>SiteGuard <b>FORMS</b></span></div>
<div class="main"><h1>${esc(card.title)}</h1><div class="line">${esc(card.line)}</div></div><div class="sub">${esc(card.sub)}</div>
</body></html>`;
}
