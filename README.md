# SiteGuard FORMS: storefront

The shop at **siteguardforms.com.au**: a multi-page static site plus a small
Express server for Stripe checkout, the Stripe webhook and the enquiry form
used by both SiteGuard websites.

## Where everything comes from

| What | Source | How it gets here |
|---|---|---|
| Packs, prices, document lists, what is on sale | Hseq-Dev `docs/build_catalogue.py` (prices from `docs/packages.py`) | `data/catalogue.json`, written by the generator |
| Legal pages and the checkout notice | SiteGuard-Forms `app/server/data/legal/*.md` | `npm run sync-legal -- <path>` copies them into `content/legal/` |
| Pages | `scripts/build-site.mjs` | `npm run build` writes `dist/` |

No product, price or legal wording is written by hand in this repo. To change
a price, change `packages.py` and re-run the generator.

**What is on sale:** a pack is listed only when every document in it is Live
IR, passed the library gate and has been mastered at its current revision.
Nothing is quoted. OFSC documents and the ISO / OFSC rungs are never listed.

**Launch waves (Pricing Rev06):** each pack carries `launch_wave` and `purchasable`. Only a sellable pack in `price_table.purchasable_waves` (`mar-2027`) is shown or can be bought; `later` packs are hidden and `/api/checkout` refuses them. Prices show as A$ "+GST": the annual subscription (the default, marked best value) beside the one-off price, then monthly.

## March 2027 launch: site mode, founding offer, product videos

- `data/site-mode.json` `beta` is FORMS ordering (unchanged). `app_status` is the SiteGuard App and Audit stage, with the same values as siteguard-website: `coming_soon` (now), `presale` (from March 2027, on Dan's go) or `live` (June 2027). While it is `presale`, a founding-offer panel shows on the home and subscriptions pages and links to the founding page on the Systems site (`/app/founding-offer/`). It says "the first 20 places" until an optional `founding_places_api` is added to the file, set to a same-origin path answering `{"remaining": n}`; then `app.js` shows the live count.
- `data/product-videos.json` (`scripts/lib/product-videos.mjs`): the FORMS product videos on the pack pages (trade, builder, high-risk and subscription slots). Paste a YouTube link as `youtube_url` and set `upload_date` to publish one. Until then a preview build shows a placeholder and a production build shows nothing. `server.js` opens the CSP for them.

## Update the catalogue (after a re-gate or a mastering batch)

```bash
# in Hseq-Dev
python3 docs/build_catalogue.py --release-set <release_set.csv> --library-index <IR_CURRENT_INDEX.csv> \
    --storefront ../SiteGuard-Forms-Storefront/data \
    --website ../siteguard-website/data \
    --forms ../SiteGuard-Forms/app/server/data
# here
npm run build:production && sudo systemctl restart siteguard-forms-storefront
```

`--preview` lists every pack for layout review. A preview build shows a
banner, is not indexed, refuses payment, and `build:production` refuses it.

## DCR (the controlled document register)

This repo is public, so it never holds the full DCR. `dcr.lock` pins siteguard-dcr's **public page-A extract** (now Rev23, `public/rev23/dcr-public.json`) by sha256, and records the sha256 of the full release it was made from. The extract is vendored under `vendor/siteguard-dcr/public/` and marked `-text`, so git never changes its bytes. It holds page A, external, non-reserved rows only, with these fields: code, title, family, revision, lifecycle status, kept code, package family and bundle. The reader is `scripts/lib/dcr.mjs`. It needs no network, deploy key or proprietary client.

- **The build** verifies the extract first and **stops on a hash mismatch**. It then fails if the catalogue shows or sells a code that isn't a live public code (retired, superseded, reserved, page B, internal or unknown), if a title differs from the DCR title, or if the catalogue's `dcr_revision` / `dcr_sha256` stamp is missing or differs from `dcr.lock`. The stamp's `dcr_sha256` is the full release's hash, `dcr.lock` `source_dcr_sha256`. Hseq-Dev `build_catalogue.py` writes both the titles and the stamp.
- **Hand edits.** `data/catalogue.json` is generated; never edit it. `dcr-check` fails it when it breaks a rule the generator always follows (`checkGenerated` in `scripts/lib/dcr.mjs`): sellable, listed and show agree, a pack's members, counts and blocked list agree, every document has the one single-document price. A pack price edited by hand is not detectable here (prices live in Hseq-Dev `packages.py`).
- The DCR never decides what is sold or its price: that is still `catalogue.json` (`packages.py`).
- **CI** runs `npm run dcr-check` (`scripts/dcr-check.mjs`) over `data/`, `content/` and the site's code. Real drift goes in `dcr.allowlist.json` with a reason; never edit product data to pass.

**Bumping the lock** (one PR per new DCR revision):
1. Copy `public/revNN/{dcr-public.json,dcr-public.sha256}` from siteguard-dcr into `vendor/siteguard-dcr/public/revNN/`.
2. Set `dcr.lock` `revision`, `path`, `sha256` and `source_dcr_sha256` (the extract's `meta.source_dcr_sha256`).
3. Re-check `dcr.allowlist.json` and set its `dcr_revision`.

## Shop and cart shared with siteguardsystems.com.au (WP-S8)

The shop pages (trade, builder, management systems, specialist and consultant packs, single documents, subscriptions, how ordering works, questions) are built by `scripts/lib/shop.mjs`, the cart page and order pages by `scripts/lib/cart.mjs`, and the browser cart is `scripts/lib/cart-browser.js`. The same three files are in siteguard-website, which renders the same shop under `/forms/` from the same catalogue (canonical tags point here) and checks out through this server. Keep them identical in both repos.

- `public/assets/app.js` is a template: the build splices the two parts of `cart-browser.js` in at its `//@@cart part 1` and `//@@cart part 2` lines.
- `test/shop-snapshot.test.js` builds the site and compares every file with `test/fixtures/dist-snapshot.json` (made from a build before the extraction; build time, `.ics` DTSTAMP, the copyright year and CRLF are taken out). Regenerate the fixture (`node test/dist-snapshot.mjs <dist>`) only for an intended change to the built site, and say so in the PR.

## Partners, affiliates and Google reviews

Same as siteguard-website (see its README); `scripts/lib/trust.mjs` and `test/trust.test.js` are identical in both repos.

- `data/partners.json` (entries with `"sites"` including `"forms"`) and `data/google-reviews.json`, written by the CRM (siteguard-ai `partners export-sites`) or by hand. Nothing shows until there's real data.
- A partner strip above the footer (not on the cart or order pages), `/partners/` with the partner enquiry form, and the Google review badge in the footer, on `/contact/` and on `/partners/`.
- `/api/lead` takes four more optional fields: `enquiry_type` (`partner` or `enquiry`), `ref` (referral code from a `?ref=` link), `partner_url` and `partner_kind`. Anything invalid is dropped. Leads land in `leads.jsonl`; the notification email adds "Enquiry type", "Partner kind", "Partner website" and "Referral code" lines, which the CRM's inbox triage reads.
- `npm run build -- --sample-partners` previews with fictional sample listings; `build:production` refuses it.

## Introduction video (landing page)

`scripts/lib/video.mjs` (the same file is in both SiteGuard sites; keep them identical) and `data/intro-video.json`. Each site has its own JSON, so each can show a different video. Nothing shows while `provider` is empty.

- **YouTube (recommended):** set `"provider": "youtube"`, `youtube_id` (the 11 characters after `watch?v=`), `title`, `description` and `upload_date`. The page shows the poster with a play button and loads the player from `youtube-nocookie.com` only when someone presses play (fast page, nothing from Google until then; without JavaScript the poster links to YouTube). Add a `poster` in `/assets/video/` to use your own thumbnail; without one YouTube's thumbnail is used.
- **Self-hosted:** `"provider": "file"`, an MP4 and a poster image in `/assets/video/` (keep the MP4 under 25 MiB, Cloudflare Pages' file limit), optional `captions` (.vtt).
- Optional: `duration` (`PT1M45S`), `heading` (the section heading), and `channel_url` + `channel_name` for a "More videos on … on YouTube" link under the video (set to the SiteGuard Education channel).
- The CSP opens `frame-src https://www.youtube-nocookie.com` (and `img-src https://i.ytimg.com` when there's no local poster) only when a YouTube video is set. A `VideoObject` is added to the home page's JSON-LD.
- An incomplete entry fails the build and nothing is shown.

The storefront server reads the same file for its CSP: restart it after a change (`sudo systemctl restart siteguard-forms-storefront`).

## Planning calendar and SiteGuard Education

`scripts/lib/planning.mjs` and `scripts/lib/education.mjs` are the same in both SiteGuard sites, and so are their data files (copy any change to both repos).

- **Planning calendar** (`data/planning-calendar.json`): public holidays and building industry RDOs per state, plus national safety initiatives and industry events. Every entry cites a source; entries without an announced date carry a `month` and show as "Date to be confirmed". Pages: `/planning/` (choose a state; national safety calendar), `/planning/<state>/` (with a subscribable `.ics` file per state) and `/planning/inspections/`.
- **Inspection and testing planner** (`data/inspection-planner.json`): interval, basis (Mandatory, Standard, Code of practice, Manufacturer, Good practice), reference and state notes for each item.
- Both files carry a `checked` date. A production build fails once it's more than 200 days old: re-check the entries against their sources (RDO calendars and 2027 dates are released through the year), then update `checked`.
- **SiteGuard Education** (`data/education.json`): `/education/` with a tab per series (About SiteGuard, How-tos, Toolbox talks, Inductions) and a page for each at `/education/<slug>/`. Every series shows from the start; one without videos says so and links the channel. To add a video, paste its YouTube link as `youtube_url` with `title`, `description` and `upload_date` (the file's `note` has the full list). Each video gets Watch on YouTube, Copy link and, with `download_url`, Download.

## How buying works

Two kinds of checkout (Dan, 1 Nov 2026, #96: Q1 "everything from one cart" is
narrowed to "everything sold on one site, two kinds of checkout"):

* **The cart** is for SiteGuard FORMS documents and packs (one-off purchases)
  only. `/api/checkout` refuses any `app:` plan or founding line with a 400 and
  a reason pointing at the right checkout.
* **SiteGuard App and Audit "Subscribe"** (`/api/subscribe`) and **"Reserve a
  founding place"** (`/api/founding/checkout`) each go straight to their own
  Stripe Checkout, never via the cart, each with its own terms to tick. Founding
  places keep the 20-place limit; the app needs account setup.
* **One beta switch** (Dan, 1 Nov 2026, #94): `data/site-mode.json` `beta` here is
  the source of truth for both sites. While it is true, `/api/checkout` refuses
  every FORMS order from either site (`source_site` forms or systems). The
  Systems site vendors this file (`vendor/siteguard-forms-storefront/site-mode.json`,
  pinned by `site-mode.lock`, with a CI drift check) and only mirrors it to hide
  its buy buttons and cart. Turning beta off opens both sites together.

* **Buy outright:** cart → `/api/checkout` (prices re-read from the catalogue,
  ex GST, `automatic_tax` adds GST) → Stripe Checkout (business name, project
  address) → webhook → each line goes to SiteGuard-Forms'
  `POST /api/v3/storefront-orders` (`packageId` = the catalogue pack id, or
  `doc:<CODE>` for a single document). FORMS fills the documents, makes the
  PDFs and emails them with the Document Use Disclaimer; its **Admin >
  Delivery** switch holds orders for a human check when on.
* **Subscribe:** the "Subscribe" buttons link to the FORMS app signup
  (`FORMS_APP_URL/signup?pack=…&cadence=annual|monthly`), which runs the
  Stripe subscription checkout. Subscriptions are not sold by this server.
* **Checkout notice:** the cart requires the SG-LEGAL-06 tick box; the server
  refuses a checkout without it and records the terms versions on the order.

## Manual delivery (go-live, 7 Nov 2026)

FORMS one-off packs are prepared and checked by hand and **delivered as PDFs by email within 3 business days** of the buyer's details being in (go-live brief Rev02, 3.1). Every pack page, the cart, the single-documents page, the Stripe page (`custom_text.submit`), the order page and the receipt email say so; the build fails on "instant", "within minutes", "download now" and similar on any non-legal page (`DELIVERY_BANNED`). After payment FORMS answers the order intake with `intakeUrl` (the buyer's details form, one per order line): the receipt email lists the link(s), and the success page (`/order/success/?session_id=…`) asks `GET /api/order/intake?session_id=…` for them. The Terms of Sale delivery clause comes from the SiteGuard-Forms legal source and still needs the same change there.

## The sellable-now list (go-live, 7 Nov 2026)

Only packs on Dan's FORMS sellable-now list are shown or sold (go-live brief Rev02, 5.2). The list lives in OneDrive (`04_BUSINESS_OPERATIONS/SG_FORMS_SELLABLE_NOW_LIST_RevNN_*.md` and `.csv`, built from DCR Rev24 and the Hseq-Dev generator). `node scripts/import-sellable-list.mjs <list.csv>` writes `data/sellable-now.json` (pack ids and document codes only, with the CSV's sha256) and a pack-level copy in `docs/go-live/`; never edit either by hand. `lib/sellable-list.js` applies it to `data/catalogue.json` in the build and at checkout, and **only narrows**: a pack the catalogue sells but the list doesn't is hidden and refused, and a held or unlisted document can't be bought singly. Titles, prices and contents still come from the catalogue and the pinned DCR. The build stops without the list; the server, given a missing or broken list, sells nothing. Each listed pack shows the delivery line and the Document Use Disclaimer summary. Rev01 (7 Nov): **72 packs** now; 9 more (Masonry, Painting and Tiling Heavy Commercial, the three builder packs and the subcontractor system) once the held Rev24 ledger entries land and the list is re-issued; the 9 `later`-wave add-ons stay hidden.

## FORMS switches (go-live, 7 Nov 2026)

SiteGuard-Forms holds the go-live switches (brief Rev02, Section 2) and enforces them itself; the storefront reads them from `GET /api/v3/storefront/switches` (same host and `x-storefront-api-key` as the order intake; `FORMS_SWITCHES_URL` overrides the URL) through `lib/forms-switches.js`, cached for 15 seconds. **Fail closed:** no URL or key, an error or a malformed answer reads as everything off.

- `sales_open` (S1): `/api/checkout` refuses (503) before Stripe while it is off, as well as while `beta` is true.
- `subscriptions_open` (S4) and `consultant_plans_open` (S5): every Subscribe button is built hidden, with **"Coming soon: register interest"** in its place (to `/subscriptions/#register-interest`, a form that posts to `/api/lead` with `enquiry_type: "forms-interest"` and `interest`: an enquiry, not a sale). `app.js` asks the storefront's `GET /api/switches` and shows the real buttons only when FORMS says the switch is on. A consultant-plan line in `/api/checkout` is refused (409) while S5 is off.
- Static wording (home, How ordering works, FAQ) is written for the switches off; rebuild with new wording when S4 or S5 is turned on.

## Stripe webhook

Register `https://www.siteguardforms.com.au/api/webhook/stripe` for
**`checkout.session.completed`** and **`checkout.session.async_payment_succeeded`**.
Orders are fulfilled only once the session is paid, once per session; a
Stripe or intake outage answers 500 so Stripe retries.

## Server settings on forms-vps (S4, overnight 8-9 Nov 2026)

`/srv/siteguard/forms-storefront/.env` on forms-vps is loaded by the unit (`EnvironmentFile=`) and by `server.js` (dotenv). Dan edits it on the server; it is never in git. These three are easy to miss:

| Setting | Set it to | Why |
|---|---|---|
| `LEAD_NOTIFICATION_EMAIL` | the mailbox that answers enquiries from both websites | Every `/api/lead` enquiry is emailed here. **Set it, or remove the line.** A blank `LEAD_NOTIFICATION_EMAIL=` line turns enquiry emails off: the fallback to `ADMIN_NOTIFICATION_EMAIL` applies only when the line is missing altogether (`server.js` uses `??`). |
| `TRUST_PROXY` | `1` when one reverse proxy sits in front of node (the usual nginx/Caddy set-up) | The rate limits (checkout, enquiries, order intake) then see the visitor's address, not the proxy's. Count each hop that adds `X-Forwarded-For`: if Cloudflare proxies the domain **and** nginx runs on the server, that's `2`. Unset, every visitor shares the proxy's limit. |
| `SUPPORT_EMAIL` | `support@siteguardsystems.com.au` | The address on the order email ("Questions, or haven't received the details form?"). Unset, it falls back to `hello@siteguardsystems.com.au` (`lib/mailer.js`). Dan's decision N1, 8 Nov 2026. |

After changing `.env`: `sudo systemctl restart siteguard-forms-storefront`, then `journalctl -u siteguard-forms-storefront -n 30 --no-pager`. The start-up lines say what is and isn't configured, never a value.

## Run it

```bash
npm ci
cp .env.example .env      # fill in
npm run build             # or build:production
npm start
npm test                  # build + unit tests
npm run test:e2e          # real browser: cart, checkout, enquiry, 360px layout
```

`build:production` fails while any legal page still has an open
`[placeholder]` (ABN, support email and so on). Fill those in the
SiteGuard-Forms legal sources, sync, and build again.

See `HARDENING.md` for the security and quality checks, and what proves each.
