# Decisions parked for Dan: SiteGuard-Forms-Storefront

The overnight run (8–9 Nov 2026) parks anything it can't settle here, with what it needs and the default it recommends, and then carries on. Answer yes or no; "yes" means take the recommended default.

## Overnight 8–9 Nov 2026 (S1–S4: #44, #45, #46, #47)

1. **Queue source.** `SG_OVERNIGHT_QUEUE_Rev07_08_Nov_2026.md` is only in your Claude project, so it isn't on this PC. S1–S4 were built from siteguard-ai `docs/go-live/SG_REMAINING_BUILD_QUEUE_Rev01_08_Nov_2026.md`, Session 3, plus your overnight decisions N1–N3. If Rev07 changes any S item, save it to OneDrive `00_CONTROL_REFERENCE` (or siteguard-ai `docs/go-live/`) and say which item. *Recommended: yes, save Rev07 where CC can read it.*
2. **Carrying utm values into the enquiry form and the cart (M2, #44).** The server now counts enquiries and paid orders that arrive with `utm_*` values. To get those values there, a small browser change has to copy them from the landing URL into the form's hidden fields and the `/api/checkout` body, with no cookie. That code lives in `cart-browser.js` and the lead form, which are shared with siteguard-website and must stay identical. *Recommended: yes, build it once in both repos as a pair, after the website's W3 lands. Until then only landings are counted.*
3. **gclid.** Rev01 W3 says to note "whether a gclid is present". The Console contract (siteguard-ai `docs/METRICS_SETUP.md` §4) says to send no other field. #44 follows the contract and doesn't count gclid. *Recommended: yes, leave gclid out.*
4. **A blank `LEAD_NOTIFICATION_EMAIL` turns enquiry emails off.** `server.js` uses `??`, so only a missing line falls back to `ADMIN_NOTIFICATION_EMAIL`. #47 documents this. *Recommended: yes, a one-line follow-up changing `??` to `||` so a blank line falls back too.*
5. **`TRUST_PROXY` on forms-vps.** It should be the number of proxy hops in front of node. Check what sits in front of node on forms-vps:
   - nginx or Caddy alone: `1`;
   - Cloudflare's proxy and nginx: `2`.

   CC doesn't read the server's `.env`, so this is yours to check. *Recommended: yes, `1` unless the domain is orange-clouded in Cloudflare.*
6. **Shared files with siteguard-website.** `scripts/lib/trust.mjs` (#45, the "See our reviews on Google" link) and `scripts/lib/shop.mjs` (#46, S20 wording) must be byte-identical in both repos, and the website session changes the same lines tonight (W6, W7). *Recommended: yes, if the two copies differ after both merge, copy the storefront's across. The website's sibling check shows any difference.*
7. **Google tag (M9, #44).** It's built and off (`GOOGLE_ADS_TAG=off`). It sets Google's cookies. *Recommended: yes, keep it off until the privacy policy covering it is approved.*

## Overnight 10–11 Nov 2026 (Rev09 Fork 3: S5 #50, S6)

8. **`cart-browser.js` must be copied to siteguard-website (X1).** S6 changes the shared `scripts/lib/cart-browser.js` (the checkout body now adds `window.sgAttribution()` when it exists; a no-op where `assets/attribution.js` isn't loaded). The website's copy has to match byte for byte. The website's W10 (the other half of the pair) is built tonight in a separate session. *Recommended: yes, the storefront's copy wins; copy it across in the website's W10 PR, or a follow-up PR if W10 lands first.*
9. **The pair's contract (X2).** Built here as: keys `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid` (hidden fields named the same); sessionStorage key `sg_attribution`, first landing in the visit wins; no cookie, no localStorage; the script `assets/attribution.js` is loaded only while `CAMPAIGN_COUNTS=on`. Counts still use the three `utm_source/medium/campaign` values only (item 3 stands: no gclid in the Console). Stripe Checkout `metadata` carries all six, cleaned, nothing personal. *Recommended: yes, the website matches this exactly.*

10. **App-page lockups (W12/S7).** The storefront builds no `/app/` pages (they're on siteguard-website), so S7 checks the header lockup (shield and "SiteGuard FORMS", linking home) on all 71 pages, plus links and self-loops. One fix: the beta bar on `/contact/` linked to `/contact/`; it now says "use the form below". *Recommended: yes, run `npm run check-site` after each build; the website's W12 covers the App pages.*

## FORMS queue 16 Nov 2026 (S9–S14: #54, #55, #56, #57, #58, #59)

1. **Snapshot fixture conflicts when merging S9–S14.** S10, S11, S12 and S14 each change built pages, so each regenerates `test/fixtures/dist-snapshot.json`. A trial merge of all six in order conflicts **only** in that file (code merges cleanly). *Recommended: yes, merge in order S9 → S14; after each one, merge `master` into the next PR and regenerate the fixture (`npm run build && node test/dist-snapshot.mjs dist > test/fixtures/dist-snapshot.json`). Ask Claude to do it if you'd rather not.*
2. **FAQ links and the FAQ page from S14 + F18.** The queue wants "Lost your documents?" linked from the FAQ, and (if time remains) an FAQ built from S14 and SiteGuard-Forms F18's support replies. `/faq/` is in `scripts/lib/shop.mjs`, which must stay identical in siteguard-website, and F18's wording isn't approved yet. *Recommended: yes, one paired storefront + website PR after you approve F18 and S10 is live.*
3. **S10 needs FORMS to say `redelivery_open`.** The storefront reads `redelivery_open` from FORMS' `GET /api/v3/storefront/switches` answer (missing = off), and forwards requests to `POST /api/v3/orders/redelivery-request` with the intake key and the client's IP in `x-forwarded-for`. *Recommended: yes, F11 adds `redelivery_open` to the switches answer and trusts `x-forwarded-for` only when the intake key is present.*
4. **The "Lost your documents?" link in FORMS' delivery email footer** belongs to SiteGuard-Forms (F11), not this repo. *Recommended: yes, F11 adds it, hidden while the switch is off.*
5. **S11 lead email has a new `Pack:` line.** siteguard-ai's `growth.parse_lead_notification` needs to read it so the CRM records the pack with the `express` or `enquiry` basis. *Recommended: yes, in Lane A (A23) after Rev10 merges.*
6. **S12 utm on shared links.** `og:url` carries `utm_source=social&utm_medium=share&utm_campaign=<page>`; `<link rel="canonical">` stays clean for search. *Recommended: yes, keep this split.*
7. **S12 "npm run check-site".** That script is in draft #52 (not merged), so S12's checks are a test (`test/share-cards.test.js`). *Recommended: yes, once #52 merges, have check-site call the same checks.*
8. **S13 adds one field to the Stripe session:** `accepted: terms-of-sale,document-use-disclaimer`, beside `termsVersion`. Checkout already refused without the tick; this records it on the Stripe side too. *Recommended: yes, keep.*
9. **Share cards are committed PNGs** (29 files, about 1.6 MB) made by `npm run share-cards` with Playwright. A trade added later uses the default card until someone re-runs it. *Recommended: yes, re-run it after any catalogue change that adds a trade.*

## Package suite audit K2, 24 Nov 2026 (builder + trade bundle at checkout)

1. **The bundle needs Hseq-Dev #64.** The pinned public price view didn't carry `bundles`, so Hseq-Dev #64 adds it to `export_price_tables.py`. This PR vendors the FORMS view as #64 writes it (the app view stays at Rev06, K5). *Recommended: yes, merge Hseq-Dev #64 first or together with this.*
2. **The rule when the cart has more than one pair:** one bundle per order, on the dearest builder pack and the dearest trade pack (ties keep cart order); everything else full price. *Recommended: yes, keep. The table's `max_trade_packs` already allows more trade packs if you raise it.*
3. **Specialist packs count as trade packs.** The table's `trade` pattern is `subcontractor:*:*`, which the specialist packs (facade, fencing, foundations, passive fire, solar) match too. *Recommended: yes, keep. To exclude them, narrow the pattern in Hseq-Dev.*
4. **Browser price fields are ignored, not refused.** A cart entry carrying `price`, `discount_pct` or `bundle` still checks out at the server's prices, as S13 already did for `price`. *Recommended: yes, keep. A 400 for those fields is a one-line change if you want one.*
5. **The cart page total shows list prices.** The 15% shows on the Stripe page (each line says "Builder + trade bundle: 15% off"), not in the cart, because the cart page is the shared `cart-browser.js`. *Recommended: yes, leave it; a paired storefront + website PR can show it in the cart later.*
6. **siteguard-website's copy of `shop.mjs`.** This PR adds an optional `ctx.bundle` (the website renders exactly as before without it). *Recommended: yes, once this merges, copy `shop.mjs` to the website again, and have it pass the bundle and vendor the FORMS view at its next export (K5).*
