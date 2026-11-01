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

## Stripe webhook

Register `https://www.siteguardforms.com.au/api/webhook/stripe` for
**`checkout.session.completed`** and **`checkout.session.async_payment_succeeded`**.
Orders are fulfilled only once the session is paid, once per session; a
Stripe or intake outage answers 500 so Stripe retries.

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
