// The SiteGuard FORMS shop pages: trade packs, builder packs, management
// systems, specialist packs, consultants, single documents, subscriptions, how
// ordering works and questions. Shared by both SiteGuard websites (the same
// file lives in SiteGuard-Forms-Storefront and siteguard-website; keep them
// identical, like trust.mjs):
//
//   siteguardforms.com.au       renders them at the site root (base "")
//   siteguardsystems.com.au     renders them under /forms/ (base "/forms"), with
//                               canonical tags pointing at siteguardforms.com.au
//
// Everything comes from data/catalogue.json (Hseq-Dev docs/build_catalogue.py);
// nothing about a product or a price is written by hand here. Each function
// returns page specs ({ url, title, description, trail, jsonld, body,
// preview }) that the site's own page() wraps in its header and footer, so the
// output on the storefront is exactly what build-site.mjs wrote before this
// file existed (test/shop-snapshot.test.js).
//
// ctx (from the site's build):
//   cat, model     the catalogue and shopModel(cat)
//   base           "" on the storefront, "/forms" on the Systems site
//   origin         the origin product JSON-LD points at (the FORMS site)
//   appUrl         the FORMS app (subscribe, consultant apply, sign in)
//   isoUrl         where "ISO and IMS services" links to
//   beta           FORMS is in beta: nothing can be bought or subscribed to
//   crumbs(trail)  the site's breadcrumb HTML
//   video(kind)    a product video band, or "" (storefront: product-videos.mjs)
//   foundingPanel()  the founding-offer panel, or ""
import { esc } from "./md.mjs";

export const LEVEL_LABEL = { "domestic": "Domestic", "light-commercial": "Light Commercial", "heavy-commercial": "Heavy Commercial" };

export const GROUP_META = {
  "trade-packs": { path: "/trade-packs/", title: "Trade packs", nav: "Trade packs" },
  "builder-packs": { path: "/builder-packs/", title: "Builder packs", nav: "Builder packs" },
  "management-systems": { path: "/management-systems/", title: "Management systems", nav: "Management systems" },
  "specialist-packs": { path: "/specialist-packs/", title: "Specialist packs", nav: "Specialist packs" },
  "consultants": { path: "/consultants/", title: "For consultants", nav: "Consultants" },
};

/** The groups with their paths under a base ("" or "/forms"). */
export function groups(base = "") {
  return Object.fromEntries(Object.entries(GROUP_META).map(([g, m]) => [g, { ...m, path: base + m.path }]));
}

export const money = (n) => "$" + Number(n).toLocaleString("en-AU");
// Customer-facing prices are A$ ex GST and say "+GST" (rebaseline standing rules).
export const exGst = (n, per = "") => `${money(n)}<small> +GST${per}</small>`;
export const packSlug = (id) => id.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

/** What the shop shows, worked out once from the catalogue. */
export function shopModel(cat) {
  const titles = new Map(cat.documents.map((d) => [d.code, d.title]));
  for (const p of cat.packs) for (const c of p.documents) if (!titles.has(c)) titles.set(c, c);
  const shown = cat.packs.filter((p) => p.show && p.prices);
  const inGroup = (g) => shown.filter((p) => p.group === g);
  // The consultants page, its nav links and its mentions appear only when a
  // consultant plan is on sale (no "coming soon").
  const consultantsOn = inGroup("consultants").some((p) => p.id !== "consultant:seat");
  const trades = cat.trades.map((t) => ({ ...t, packs: shown.filter((p) => p.trade === t.code) })).filter((t) => t.packs.length);
  const preview = cat.preview;
  // The shop's own numbers count what can be bought here (every listed
  // document in a preview), not the whole library.
  const onSale = cat.documents.filter((d) => preview || d.sellable);
  const counts = {
    documents: onSale.length,
    swms: onSale.filter((d) => d.family === "SWMS").length,
    trades: trades.length,
  };
  const fromOf = (packs) => {
    const v = packs.map((p) => p.prices.one_off ?? p.prices.annual);
    return v.length ? Math.min(...v) : null;
  };
  return { titles, shown, inGroup, consultantsOn, trades, preview, counts, fromOf };
}

export function emptyState(what) {
  return `<div class="note"><p><strong>No ${esc(what)} are available to buy right now.</strong></p>
  <p>Tell us what you need and we'll reply within one business day.</p>
  <p><a class="btn btn-small" href="/contact/">Contact us</a></p></div>`;
}

/** "Choose a range": one row per group with something on sale. */
export function rangesHtml(model, base = "") {
  const G = groups(base);
  return Object.entries(G).map(([g, meta]) => {
    let packs = model.inGroup(g);
    if (!packs.length) return "";
    const from = model.fromOf(packs);
    const blurb = {
      "trade-packs": "SWMS, safety plans and ITPs for one trade, at Domestic, Light Commercial or Heavy Commercial level.",
      "builder-packs": "Every trade's SWMS for a builder running the whole site, up to a full management system.",
      "management-systems": "The Core Management System: safety, quality and environmental management system documents aligned to the ISO standards.",
      "specialist-packs": "Fencing, passive fire, solar and EV, foundations, and facade and cladding.",
      "consultants": "Prepare documents for your own clients under your brand or theirs. Plans by number of clients.",
    }[g];
    if (g === "consultants") packs = packs.filter((p) => p.id !== "consultant:seat");
    return `<div class="register-row"><div><h3><a href="${meta.path}">${meta.title}</a></h3><p>${blurb}</p></div>
      <p class="from">From ${money(from)}<small> +GST</small><span>${packs.length} ${packs.length === 1 ? "package" : "packages"}</span></p>
      <a class="btn btn-small" href="${meta.path}">View ${meta.title.toLowerCase()}</a></div>`;
  }).join("");
}

/** How a pack works, under the packs on every pack page: contents (codes and
 *  titles from SiteGuard's controlled document register), project details in,
 *  PDFs out, revisions after each 6-monthly review. */
export function packHow() {
  return `<section class="band band-grey" aria-labelledby="pack-how-h"><div class="wrap">
  <h2 id="pack-how-h">How a pack works</h2>
  <ol class="steps steps-row">
    <li><h3>What's in it</h3><p>The documents listed in each pack above, by code and title as they stand in SiteGuard's controlled document register. Every document carries its reference, revision and date.</p></li>
    <li><h3>Your project details in</h3><p>Enter your business and project details once: at checkout for a one-off purchase, or for each project in your account when you subscribe.</p></li>
    <li><h3>PDFs out</h3><p>Every document in the pack is filled with those details and emailed to you as PDFs, ready for you to review and adapt to your work and site.</p></li>
    <li><h3>Kept current</h3><p>The whole library has a legislative review every 6 months. Subscribers get the revised documents pushed to their account after each review.</p></li>
  </ol>
</div></section>`;
}

/**
 * Every shop page, in the order the storefront has always built them, and the
 * data files the pages load ({ pages, files }: files are [path under dist,
 * content] pairs).
 */
export function shopPages(ctx) {
  const { cat, model, base = "", origin, appUrl, isoUrl, beta = false, crumbs, video = () => "", foundingPanel = () => "" } = ctx;
  const G = groups(base);
  const { titles, inGroup, trades, fromOf } = model;
  const preview = cat.preview;
  const CONSULTANTS_ON = model.consultantsOn;
  const pages = [];
  const page = (spec) => pages.push(spec);
  const lazyLists = new Map();
  const P = (p) => base + p;

  function subscribeHref(p, cadence) {
    const q = new URLSearchParams({ pack: p.id, cadence, label: p.name, price: String(cadence === "annual" ? p.prices.annual : p.prices.monthly) });
    // Consultant plans (Pricing Rev03 3.A3, 20 Oct 2026): every consultant
    // account needs admin approval first -- sign straight into checkout
    // would let an unapproved tenant buy a plan with nothing behind it.
    // The pack/cadence query stays on the link so the apply page can tell
    // the applicant what they'll be subscribing to once approved.
    if (p.id.startsWith("consultant:")) {
      q.set("type", "consultant");
      return `${appUrl}/consultant/apply?${q}`;
    }
    return `${appUrl}/signup?${q}`;
  }

  /** Short lists are written into the page; long ones (builder and consultant
   *  packs run to hundreds of documents) load when the list is opened. */
  function docList(p) {
    const rows = p.documents.map((c) => [c, titles.get(c) ?? c]);
    if (rows.length > 60) {
      lazyLists.set(packSlug(p.id), rows);
      return `<details class="doclist" data-lazy-docs="${P("/assets/packs/")}${packSlug(p.id)}.json"><summary>See all ${rows.length} documents</summary><ol><li><span></span><span>Loading the list…</span></li></ol></details>`;
    }
    const items = rows.map(([c, t]) => `<li><span class="code">${esc(c)}</span><span>${esc(t)}</span></li>`).join("");
    return `<details class="doclist"><summary>See all ${rows.length} documents</summary><ol>${items}</ol></details>`;
  }

  /** Prices for one pack: the annual subscription (the default and best value)
   *  beside the one-off purchase, then monthly. Prices are A$ ex GST from the
   *  catalogue (Hseq-Dev docs/packages.py, which reads
   *  docs/pricing/forms_price_table.json, Pricing Rev06). A pack outside the
   *  purchasable launch waves is never buyable here. */
  function priceBlock(p) {
    const onSale = !cat.preview && !beta && p.sellable && p.purchasable !== false;
    const disabled = onSale ? "" : ' aria-disabled="true" data-preview-disabled="1"';
    const monthlyExtra = p.prices.monthly * 12 - p.prices.annual;
    const annual = `<div class="price-opt price-opt-best">
       <p class="price-tag">Best value</p>
       <p class="price-head">Annual subscription</p>
       <p class="amount">${exGst(p.prices.annual, " a year")}</p>
       <p class="price-note">Unlimited projects. Revised documents after every 6-monthly review.</p>
       <a class="btn btn-hivis btn-small" href="${esc(subscribeHref(p, "annual"))}"${disabled}>Subscribe yearly</a>
     </div>`;
    const oneOff = p.prices.one_off
      ? `<div class="price-opt">
       <p class="price-tag price-tag-plain">Pay once</p>
       <p class="price-head">One-off purchase</p>
       <p class="amount">${exGst(p.prices.one_off)}</p>
       <p class="price-note">The current revision, filled with your details and emailed as PDFs.</p>
       <button type="button" class="btn btn-small" data-add-pack="${esc(p.id)}" data-name="${esc(p.name)}" data-price="${p.prices.one_off}"${disabled}>Add to cart</button>
     </div>`
      : "";
    return `<div class="prices">
    <div class="price-pair">${annual}${oneOff}</div>
    <p class="price-monthly">Or monthly: ${exGst(p.prices.monthly, " a month")}${monthlyExtra > 0 ? `, ${money(monthlyExtra)} more over a year` : ""}. <a href="${esc(subscribeHref(p, "monthly"))}"${disabled}>Subscribe monthly</a></p>
    ${p.purchasable === false ? '<p class="gst"><strong>Not yet available to buy.</strong></p>' : ""}
    <p class="gst">Prices in A$, excluding GST. GST is added at checkout.${p.subscription_only ? " Available by subscription only." : ""}</p>
  </div>`;
  }

  function packArticle(p, heading) {
    return `<article class="rung" id="${esc(packSlug(p.id))}">
    <h3>${esc(heading ?? p.name)}</h3>
    <p class="summary">${esc(p.summary)}</p>
    <ul>${p.includes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${docList(p)}
    ${priceBlock(p)}
  </article>`;
  }

  /** Consultant plans as one table: every plan has the same library, so the
   *  document list is shown once, under the table. */
  function consultantPlans(plans) {
    if (!plans.length) return "";
    const onSale = (p) => !cat.preview && !beta && p.sellable && p.purchasable !== false;
    const dis = (p) => onSale(p) ? "" : ' aria-disabled="true" data-preview-disabled="1"';
    const rows = plans.map((p) => `<tr id="${esc(packSlug(p.id))}">
      <th scope="row">${esc(p.name)}</th>
      <td>${p.client_limit == null ? "No limit" : p.client_limit === 1 ? "1" : `Up to ${p.client_limit}`}</td>
      <td>${p.seats_included ?? ""}</td>
      <td class="num">${exGst(p.prices.annual, " a year")}<br><span class="small">or ${money(p.prices.monthly)} +GST a month</span></td>
      <td><div class="btn-row"><a class="btn btn-small" href="${esc(subscribeHref(p, "annual"))}"${dis(p)}>Yearly</a><a class="btn btn-small" href="${esc(subscribeHref(p, "monthly"))}"${dis(p)}>Monthly</a></div></td>
    </tr>`).join("");
    const lib = plans.at(-1);
    return `<div class="table-scroll"><table class="doc-table plan-table"><thead><tr><th scope="col">Plan</th><th scope="col">Clients a year</th><th scope="col">Users included</th><th scope="col">Price</th><th scope="col"><span class="hp">Subscribe</span></th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="gst">Prices in A$, excluding GST. Available by subscription only.</p>
  <h2 class="mt-lg">The library on every plan</h2>
  <ul>${lib.includes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  ${docList(lib)}`;
  }

  function productLd(p, url) {
    const offers = [];
    if (p.prices.one_off) offers.push({ "@type": "Offer", name: "Buy outright", priceCurrency: "AUD", price: p.prices.one_off, availability: "https://schema.org/InStock", url: origin + url,
      priceSpecification: { "@type": "PriceSpecification", price: p.prices.one_off, priceCurrency: "AUD", valueAddedTaxIncluded: false } });
    offers.push({ "@type": "Offer", name: "Annual subscription", priceCurrency: "AUD", price: p.prices.annual, availability: "https://schema.org/InStock", url: origin + url,
      priceSpecification: { "@type": "UnitPriceSpecification", price: p.prices.annual, priceCurrency: "AUD", valueAddedTaxIncluded: false, billingDuration: "P1Y" } });
    return { "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.summary, sku: p.id,
      brand: { "@type": "Brand", name: "SiteGuard FORMS" }, offers };
  }
  // Product JSON-LD always names the page on the FORMS site (the canonical one).
  const ldUrl = (url) => url.slice(base.length);

  // Trade and specialist index + per-trade pages
  for (const g of ["trade-packs", "specialist-packs"]) {
    const meta = G[g];
    const gTrades = trades.filter((t) => t.group === g);
    const rows = gTrades.map((t) => {
      const heavy = t.packs.at(-1);
      const swms = (heavy.includes.find((x) => / SWMS$/.test(x) && !/core/.test(x)) ?? "").replace(/ SWMS$/, " SWMS");
      return `<div class="register-row"><div><h3><a href="${meta.path}${t.slug}/">${esc(t.name)}</a></h3>
        <p>${esc(t.packs.map((p) => LEVEL_LABEL[p.level]).join(", "))}${swms ? `. ${esc(swms.replace(t.name + " ", ""))} for the trade.` : ""}</p></div>
        <p class="from">From ${money(fromOf(t.packs))}<small> +GST</small><span>one-off purchase</span></p>
        <a class="btn btn-small" href="${meta.path}${t.slug}/">Choose a level</a></div>`;
    }).join("");
    const addons = g === "specialist-packs" ? inGroup(g).filter((p) => !p.trade) : [];
    const intro = g === "trade-packs"
      ? "Pick your trade, then the level of work. Each level adds what head contractors ask for at that scale."
      : "Packs for specialist trades and work types, at Domestic, Light Commercial or Heavy Commercial level.";
    for (const t of gTrades) {
      const url = `${meta.path}${t.slug}/`;
      page({
        url, preview, title: `${t.name} packs`,
        description: `${t.name} SWMS, safety management plans and ITPs at Domestic, Light Commercial and Heavy Commercial level. Buy outright or subscribe.`,
        trail: [[meta.path, meta.title], [url, t.name]],
        jsonld: t.packs.map((p) => productLd(p, ldUrl(url))),
        body: `<section class="page-head"><div class="wrap">${crumbs([[meta.path, meta.title], [url, t.name]])}
  <h1>${esc(t.name)} packs</h1>
  <p class="lede">Choose the level that matches the work. Every level includes the ${esc(t.name.toLowerCase())} SWMS and the core site SWMS.</p></div></section>
<section class="band"><div class="wrap">
  <div class="rungs">${t.packs.map((p) => packArticle(p, LEVEL_LABEL[p.level])).join("")}</div>
  <p class="small mt">Buying outright: the documents are filled with the business and project details you enter at checkout and emailed to you. Subscribing: sign in, add your logo and projects, and generate the documents whenever you need them. <a href="${P("/how-ordering-works/")}">How ordering works</a>.</p>
</div></section>
${video(g === "specialist-packs" ? "high-risk" : "trade")}
${packHow()}`,
      });
    }
    page({
      url: meta.path, preview, title: meta.title,
      description: g === "trade-packs" ? "SWMS, safety plans and ITPs for your trade, at Domestic, Light Commercial or Heavy Commercial level." : "SWMS, safety plans and ITPs for specialist trades: fencing, passive fire, solar and EV, foundations, and facade and cladding.",
      trail: [[meta.path, meta.title]],
      body: `<section class="page-head"><div class="wrap">${crumbs([[meta.path, meta.title]])}<h1>${meta.title}</h1><p class="lede">${intro}</p></div></section>
<section class="band"><div class="wrap">
  ${rows ? `<div class="register">${rows}</div>` : (addons.length ? "" : emptyState(meta.title.toLowerCase()))}
  ${addons.length ? `<h2 class="mt-lg">Other specialist packs</h2><div class="rungs">${addons.map((p) => packArticle(p)).join("")}</div>` : ""}
</div></section>
${video(g === "specialist-packs" ? "high-risk" : "trade")}`,
      jsonld: addons.map((p) => productLd(p, ldUrl(meta.path))),
    });
  }

  // Builder, management systems, consultants: packs on one page
  const groupIntro = {
    "builder-packs": "For builders running the whole site: every trade's SWMS, then safety plans and governance, then the full management system.",
    "management-systems": "Management-system documents aligned to the ISO standards, ready to adapt to how your business works. ISO certification support is consulting work through SiteGuard Systems.",
    "consultants": "Consultant plans let you prepare documents for your own clients, issued under your brand or your client's. Every plan includes the whole library; plans differ by how many clients you serve.",
  };
  const extraSeat = inGroup("consultants").find((p) => p.id === "consultant:seat");
  for (const g of ["builder-packs", "management-systems", "consultants"]) {
    const meta = G[g];
    if (g === "consultants" && !CONSULTANTS_ON) continue;
    const packs = inGroup(g).filter((p) => p.id !== "consultant:seat");
    const extra = g === "consultants" ? `<section class="band band-grey"><div class="wrap cols">
  <div><h2>How it works</h2><ol class="steps">
    <li><h3>Choose a plan</h3><p>Pick the plan that covers the number of clients you serve in a year, yearly or monthly. Your account is set up as a consultant account.</p></li>
    <li><h3>Add a client</h3><p>Enter the client's business details and ABN, and upload their logo if you want their brand on the documents.</p></li>
    <li><h3>Generate and send</h3><p>Pick the documents and generate them as PDFs under your brand or your client's, ready to send.</p></li>
  </ol></div>
  <div><h2>Plans and users</h2><p>A client counts towards your plan once you generate a document for it in your subscription year. Need more clients? Move up a plan at any time; you pay only the difference for the rest of the year.</p>
  ${extraSeat ? `<p>Each plan includes the users shown. Extra users are ${money(extraSeat.prices.annual)} a year each.</p>` : ""}
  <h2>The licence</h2><p>You may use and adapt the documents while delivering services to your own clients. You may not resell the templates as a standalone product or publish them. <a href="/legal/consultant-licence/">Read the Consultant Licence</a>.</p>
  <p>Every set you generate includes a Document Use Disclaimer for your client.</p></div>
</div></section>` : g === "management-systems" ? `<section class="band band-grey"><div class="wrap"><div class="note"><p>Looking for ISO 45001, ISO 9001 or ISO 14001 implementation, an integrated management system or audit readiness support? That is consulting work. <a href="${isoUrl}">See SiteGuard Systems ISO and IMS services</a>.</p></div></div></section>` : "";
    page({
      url: meta.path, preview, title: meta.title, trail: [[meta.path, meta.title]],
      description: groupIntro[g], jsonld: packs.map((p) => productLd(p, ldUrl(meta.path))),
      body: `<section class="page-head"><div class="wrap">${crumbs([[meta.path, meta.title]])}<h1>${meta.title}</h1><p class="lede">${groupIntro[g]}</p></div></section>
<section class="band"><div class="wrap">${g === "consultants" ? consultantPlans(packs) : packs.length ? `<div class="rungs">${packs.map((p) => packArticle(p)).join("")}</div>` : emptyState(meta.title.toLowerCase())}</div></section>${g === "builder-packs" ? video("builder") : ""}${g !== "consultants" && packs.length ? packHow() : ""}${extra}`,
    });
  }

  // Single documents
  const docs = cat.documents.filter((d) => preview || d.sellable)
    .map(({ code, title, family, trade_name }) => ({ code, title, family, trade: trade_name ?? "" }));
  const families = [...new Set(docs.map((d) => d.family))].sort();
  const docTrades = [...new Set(docs.map((d) => d.trade).filter(Boolean))].sort();
  const docPrice = cat.documents[0]?.price ?? null;
  page({
    url: P("/documents/"), preview, title: "Single documents", trail: [[P("/documents/"), "Single documents"]],
    description: `Buy one document at a time: SWMS, ITPs, plans, policies, forms and registers${docPrice ? `, ${money(docPrice)} +GST each` : ""}.`,
    body: `<section class="page-head"><div class="wrap">${crumbs([[P("/documents/"), "Single documents"]])}<h1>Single documents</h1>
  <p class="lede">Need one document, not a pack? ${docPrice ? `Each document is ${money(docPrice)} +GST, bought outright.` : ""} A pack is better value once you need more than a few.</p></div></section>
<section class="band"><div class="wrap">
  <form class="filters" data-doc-filters role="search" aria-label="Filter documents">
    <label>Search<input type="search" name="q" placeholder="Code or title" autocomplete="off"></label>
    <label>Type<select name="family"><option value="">All types</option>${families.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
    <label>Trade<select name="trade"><option value="">All trades</option>${docTrades.map((x) => `<option>${esc(x)}</option>`).join("")}</select></label>
  </form>
  <p class="small" data-doc-count aria-live="polite"></p>
  <table class="doc-table" data-doc-table data-price="${docPrice ?? ""}"><thead><tr><th scope="col">Code</th><th scope="col">Title</th><th scope="col">Type</th><th scope="col"><span class="hp">Add</span></th></tr></thead><tbody></tbody></table>
  <noscript><p>The document finder needs JavaScript. <a href="/contact/">Contact us</a> and we'll help you find the document you need.</p></noscript>
  ${docs.length ? "" : emptyState("single documents")}
</div></section>`,
  });
  const files = [[`${base.slice(1)}${base ? "/" : ""}assets/documents.json`, JSON.stringify({ price: docPrice, preview, documents: docs })]];

  // Subscriptions
  page({
    url: P("/subscriptions/"), preview, title: "Subscriptions", trail: [[P("/subscriptions/"), "Subscriptions"]],
    description: "Subscribe to any package yearly or monthly: unlimited use, your logo and projects, and documents updated after every 6-monthly legislative review.",
    body: `<section class="page-head"><div class="wrap">${crumbs([[P("/subscriptions/"), "Subscriptions"]])}<h1>Subscriptions</h1>
  <p class="lede">Every package is available on an annual subscription, our default and best value, and most can also be bought outright. A subscription keeps your documents current and lets you generate them for every project.</p></div></section>
${foundingPanel()}
<section class="band"><div class="wrap cols">
  <div><h2>What you get</h2><ul>
    <li><strong>Unlimited use.</strong> No limit on projects or how often you generate documents.</li>
    <li><strong>Your branding, included.</strong> Upload your logo once and it goes on every document, at no extra cost.</li>
    <li><strong>Project details filled in.</strong> Set up each project and the documents are generated with its details, as PDFs, emailed to you.</li>
    <li><strong>Kept current.</strong> The library is reviewed against legislative change every 6 months, and the revised documents are pushed to your account after each review.</li>
  </ul></div>
  <div><h2>Billing</h2>
    <p><strong>Annual billing is the default and the best value.</strong> Each pack page shows the annual price beside the one-off price. You can pay monthly instead, at a higher annualised rate (the yearly price plus 15%, spread over 12 months and rounded). Prices are in A$ and exclude GST (+GST); GST is added at checkout.</p>
    <p>Subscriptions renew automatically. Cancel at any time from your account; cancellation takes effect at the end of the period you've paid for. See the <a href="/legal/terms-of-sale/">Terms of Sale</a> and <a href="/legal/refunds/">Refunds and cancellations</a>.</p>
    <p><a class="btn btn-hivis" href="${P("/trade-packs/")}">Choose a package</a></p>
    <p class="small">Already subscribed? <a href="${appUrl}/login">Sign in</a>.</p></div>
</div></section>
${video("subscription")}`,
  });

  // How ordering works
  page({
    url: P("/how-ordering-works/"), preview, title: "How ordering works", trail: [[P("/how-ordering-works/"), "How ordering works"]],
    description: "Choose a package, pay securely, and receive your documents as PDFs with your details filled in, within one business day.",
    body: `<section class="page-head"><div class="wrap">${crumbs([[P("/how-ordering-works/"), "How ordering works"]])}<h1>How ordering works</h1></div></section>
<section class="band"><div class="wrap cols">
  <div><h2>Buying outright</h2><ol class="steps">
    <li><h3>Choose your package</h3><p>Pick a pack for your trade or business, or single documents, and add them to your cart.</p></li>
    <li><h3>Pay securely</h3><p>Checkout is handled by Stripe. Enter your business name and project address; GST is added and shown on your tax invoice.</p></li>
    <li><h3>Receive your documents</h3><p>The documents are filled with your details and emailed to you as PDFs, with the Document Use Disclaimer, within one business day and often within minutes.</p></li>
  </ol></div>
  <div><h2>Subscribing</h2><ol class="steps">
    <li><h3>Choose a package and billing</h3><p>Select "Subscribe yearly" or "Subscribe monthly" on any package and create your account.</p></li>
    <li><h3>Add your logo and projects</h3><p>Upload your logo, enter your business details, and set up each project.</p></li>
    <li><h3>Generate and email</h3><p>Generate the documents for a project and send them to your nominated email address with one button, as often as you need.</p></li>
    <li><h3>Stay current</h3><p>After each 6-monthly legislative review, the updated documents are in your account.</p></li>
  </ol></div>
</div></section>
<section class="band band-grey"><div class="wrap"><div class="note"><p><strong>Before you use a document:</strong> every document is a template. Review it, adapt it to your work and site, consult your workers, and keep it current. <a href="/legal/document-use-disclaimer/">Document Use Disclaimer</a>.</p></div></div></section>`,
  });

  // FAQ
  const faq = [
    ["What format are the documents?", "PDF, with your business and project details filled in. Subscribers can also add their logo."],
    ["How quickly will I get them?", "By email within one business day of payment, and often within minutes."],
    ["Are prices inclusive of GST?", "No. Prices exclude GST. GST is calculated and added at checkout and shown on your tax invoice."],
    ["Can I use the documents on more than one project?", "Yes. Both outright purchases and subscriptions allow use across your own business and projects. A subscription also lets you generate the documents for each project with its details."],
    ["How are documents kept up to date?", "The whole library is reviewed against legislative change every 6 months. Subscribers receive the updated documents."],
    ["Do the documents meet my legal obligations on their own?", "No document can do that on its own. They are written to Australian WHS laws and aligned to the ISO standards, but the business using them must review and adapt each one to its work and site, consult its workers and keep it current."],
    ["Can I cancel a subscription?", "Yes, at any time from your account. Cancellation takes effect at the end of the period you've paid for."],
    ...(CONSULTANTS_ON ? [["I'm a consultant. Can I use these for my clients?", "Yes, with a consultant plan. Plans are priced by how many clients you serve, and documents are issued under your brand or your client's. See the consultants page and the Consultant Licence."]] : []),
    ["Can you write a custom SWMS or build our management system?", "Yes. That is consulting work through SiteGuard Systems. Contact us and we'll reply within one business day."],
  ];
  page({
    url: P("/faq/"), preview, title: "Questions", trail: [[P("/faq/"), "Questions"]],
    description: "Answers about formats, delivery times, GST, subscriptions, updates and consultant use.",
    jsonld: [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }],
    body: `<section class="page-head"><div class="wrap">${crumbs([[P("/faq/"), "Questions"]])}<h1>Questions</h1></div></section>
<section class="band"><div class="wrap prose">${faq.map(([q, a]) => `<h2 class="faq-q">${esc(q)}</h2><p>${esc(a)}</p>`).join("")}</div></section>`,
  });

  for (const [slug, rows] of lazyLists) files.push([`${base.slice(1)}${base ? "/" : ""}assets/packs/${slug}.json`, JSON.stringify(rows)]);
  return { pages, files };
}
