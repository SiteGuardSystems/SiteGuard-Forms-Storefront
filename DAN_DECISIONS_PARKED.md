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
