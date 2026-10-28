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
- Optional: `duration` (`PT1M45S`), `heading` (the section heading).
- The CSP opens `frame-src https://www.youtube-nocookie.com` (and `img-src https://i.ytimg.com` when there's no local poster) only when a YouTube video is set. A `VideoObject` is added to the home page's JSON-LD.
- An incomplete entry fails the build and nothing is shown.

The storefront server reads the same file for its CSP: restart it after a change (`sudo systemctl restart siteguard-forms-storefront`).

## How buying works

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
