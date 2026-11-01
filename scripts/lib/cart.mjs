// The SiteGuard cart: the cart page, the order result pages and the browser
// cart code. Shared by both SiteGuard websites (the same file, and the same
// scripts/lib/cart-browser.js, live in SiteGuard-Forms-Storefront and
// siteguard-website; keep them identical, like trust.mjs).
//
// One checkout engine: the storefront's server (POST /api/checkout, which
// re-prices every line from the catalogue and opens Stripe Checkout). The
// storefront posts to it same-origin; the Systems site posts to it
// cross-origin (ctx.engine), with returnOrigin and source_site so the engine
// sends the buyer back to the site they came from.
//
// The browser code (scripts/lib/cart-browser.js) is two parts:
//   part 1  the cart itself: money, load, save, the header count, toast, add
//   part 2  add-to-cart buttons, long document lists, the cart page and its
//           checkout form, and the single-documents finder
// On the storefront, build-site.mjs splices them into public/assets/app.js at
// the "//@@cart part N" lines (spliceCart), so the built app.js is
// byte-for-byte what it was before the extraction. On the Systems site,
// systemsCartScript() wraps them in their own file (/assets/cart.js).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { esc } from "./md.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BROWSER_FILE = path.join(HERE, "cart-browser.js");

/** The two parts of cart-browser.js, exactly as they appear in the file. */
export async function cartBrowserParts(file = BROWSER_FILE) {
  const text = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
  const m = text.match(/\n\/\/@@part 1\n([\s\S]*?)\/\/@@part 2\n([\s\S]*?)\/\/@@end\n/);
  if (!m) throw new Error(`${file}: expected //@@part 1, //@@part 2 and //@@end marker lines`);
  return [m[1], m[2]];
}

/** The storefront's app.js: the template with the two parts in place, in the
 *  template's own line endings (a Windows checkout may have CRLF). */
export function spliceCart(template, parts) {
  const eol = template.includes("\r\n") ? "\r\n" : "\n";
  let out = template.replace(/\r\n/g, "\n");
  parts.forEach((part, i) => {
    const marker = `  //@@cart part ${i + 1}\n`;
    if (out.split(marker).length !== 2) throw new Error(`app.js template: expected one "//@@cart part ${i + 1}" line`);
    out = out.replace(marker, () => part);
  });
  return eol === "\n" ? out : out.replace(/\n/g, eol);
}

/**
 * The Systems site's /assets/cart.js: the same two parts, with the few names
 * the storefront's app.js gives them (KEY, beta, preview, ROOT) and a fetch
 * that sends POST /api/checkout to the engine with returnOrigin and
 * source_site. Everything else (lists, documents.json) is fetched as is.
 */
export function systemsCartScript(parts, { engine, root = "/forms/", key = "sg-cart-v1", site = "systems" }) {
  const origin = new URL(engine).origin;
  return `// SiteGuard cart on the Systems site. Built by build.mjs from
// scripts/lib/cart-browser.js (the same code as siteguardforms.com.au's cart).
// Checkout goes to the one checkout engine, ${origin}, which re-prices every
// line from the catalogue and returns the buyer to this site.
(function () {
  "use strict";
  var KEY = ${JSON.stringify(key)};
  var beta = document.body.getAttribute("data-beta") === "1";
  var preview = document.body.getAttribute("data-preview") === "1" || beta;
  var ROOT = ${JSON.stringify(root)};
  var ENGINE = ${JSON.stringify(origin)};
  var fetch = function (url, opts) {
    if (url === "/api/checkout" && opts && opts.method === "POST") {
      var body = JSON.parse(opts.body);
      body.returnOrigin = window.location.origin;
      body.source_site = ${JSON.stringify(site)};
      return window.fetch(ENGINE + "/api/checkout", { method: "POST", mode: "cors", credentials: "omit",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    }
    return window.fetch(url, opts);
  };
${parts[0]}${parts[1]}  renderCount();
})();
`;
}

/** The terms version a checkout records (SG-LEGAL-02 and SG-LEGAL-01). */
export const termsVersion = (sale, disclaimer) => `SG-LEGAL-02 v${sale.meta.version}; SG-LEGAL-01 v${disclaimer.meta.version}`;

/**
 * The cart page and the order result pages, as page specs.
 * ctx: { crumbs, preview, noticeHtml, termsVersion, shopHome ("/" or "/forms/"),
 *        browse ("/trade-packs/" or "/forms/trade-packs/"), engine (Systems only) }
 */
export function cartPages(ctx) {
  const { crumbs, preview, noticeHtml, shopHome = "/", browse = "/trade-packs/", engine } = ctx;
  const pages = [];
  pages.push({
    url: "/cart/", preview, title: "Your cart", trail: [["/cart/", "Cart"]],
    description: "Review your cart and pay securely.",
    body: `<section class="page-head"><div class="wrap">${crumbs([["/cart/", "Cart"]])}<h1>Your cart</h1></div></section>
<section class="band"><div class="wrap">
  <div data-cart-view><p>Your cart is empty. <a href="${browse}">Browse trade packs</a>.</p></div>
  <form class="form form-wide" data-checkout-form${engine ? ` data-engine="${esc(new URL(engine).origin)}"` : ""} hidden>
    ${noticeHtml}
    <label for="cart-site-name">Site name (optional)</label>
    <input id="cart-site-name" name="siteName" type="text" maxlength="100" autocomplete="off" aria-describedby="cart-site-name-hint">
    <p class="small" id="cart-site-name-hint">Printed in the Site Name field on your documents, for example "Riverside Apartments Stage 2". Leave it blank to write it in by hand.</p>
    <label class="check"><input type="checkbox" name="accept" aria-required="true"> <span>I have read and accept the <a href="/legal/terms-of-sale/">Terms of Sale</a> and the <a href="/legal/document-use-disclaimer/">Document Use Disclaimer</a>.</span></label>
    <input type="hidden" name="termsVersion" value="${esc(ctx.termsVersion)}">
    <p class="form-status" data-status aria-live="polite"></p>
    <div class="btn-row"><button class="btn btn-hivis" type="submit">Go to secure checkout</button></div>
    <p class="small">You'll enter your business name and project address on the next page. The site name above is optional. Subscriptions are set up from each package's "Subscribe" button.</p>
  </form>
</div></section>`,
  });
  pages.push({
    url: "/order/success/", preview, title: "Order received", trail: [["/order/success/", "Order received"]],
    description: "Your order has been received.",
    body: `<section class="page-head"><div class="wrap"><h1>Thank you. Your order is in.</h1>
  <p class="lede">We've emailed your receipt. Your documents will follow by email within one business day, and often within minutes.</p>
  <p><a class="btn" href="${shopHome}">Back to the shop</a></p></div></section>`,
  });
  pages.push({
    url: "/order/cancelled/", preview, title: "Checkout cancelled", trail: [["/order/cancelled/", "Checkout cancelled"]],
    description: "Checkout was cancelled. Nothing was charged.",
    body: `<section class="page-head"><div class="wrap"><h1>Checkout cancelled</h1><p class="lede">Nothing was charged. Your cart is still here.</p><p><a class="btn btn-hivis" href="/cart/">Return to your cart</a></p></div></section>`,
  });
  return pages;
}
