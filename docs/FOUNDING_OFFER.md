# App billing and the founding offer

Status: Stripe TEST MODE only. Nothing here is live until Dan gives the go.
Customer-facing wording is marked PENDING SOLICITOR until the approved text
replaces it in `data/app-billing.json`.

## What it does

- Sells the SiteGuard App line-up from Pricing Rev06 (A$ ex GST, GST added by
  Stripe Tax at checkout):

  | Product id | A$ a month | Annual (default) | 6-monthly (+3%) | Quarterly (+5%) | Monthly (+8%) | Founding (12 months less 15%) |
  |---|---|---|---|---|---|---|
  | `app:trade:domestic` | 196 | 2,352.00 | 1,211.28 | 617.40 | 211.68 | 1,999.20 |
  | `app:trade:light-commercial` | 271 | 3,252.00 | 1,674.78 | 853.65 | 292.68 | 2,764.20 |
  | `app:trade:heavy-commercial` | 496 | 5,952.00 | 3,065.28 | 1,562.40 | 535.68 | 5,059.20 |
  | `app:builder:domestic` | 910 | 10,920.00 | 5,623.80 | 2,866.50 | 982.80 | 9,282.00 |
  | `app:builder:light-commercial` | 1,279 | 15,348.00 | 7,904.22 | 4,028.85 | 1,381.32 | 13,045.80 |
  | `app:builder:heavy-commercial` | 1,757 | 21,084.00 | 10,858.26 | 5,534.55 | 1,897.56 | 17,921.40 |
  | `app:audit:seat` (per seat) | 75 | 900.00 | 463.50 | 236.25 | 81.00 | 765.00 |

- The founding offer: 20 places; 12 months of the chosen product paid up front
  at 15% off; the 12 months start on the app go-live date, not on payment; the
  matching FORMS pack is granted at purchase; one free month per month of
  delay, applied automatically when the go-live date moves; a refund of the
  unused prepayment on request.

No gated product is configured or provisioned. `validateAppBilling` refuses a
config that names one.

## Files

| File | What |
|---|---|
| `data/app-billing.json` | Prices, cadences, go-live date, founding rules, FORMS-pack mapping, checkout notice text. The one place to change any of them. |
| `data/app-billing-stripe.test.json` | Stripe TEST product and price ids, written by `scripts/sync-app-stripe.mjs`. A live file only on Dan's go. |
| `lib/app-billing.js` | Pure rules: prices, dates, delay credit, unused prepayment, FORMS-pack mapping, notice. |
| `lib/founding-ledger.js` | The stock of 20, reservations and sale records (`var/founding/ledger.json`). |
| `lib/app-routes.js` | The HTTP routes and the webhook handling below. |
| `scripts/sync-app-stripe.mjs` | Provisions the Stripe products and prices. Refuses a live key without `--confirm-live`. |
| `test/founding.test.js` | Unit and HTTP tests (fake Stripe). |
| `test/e2e/stripe-test-mode.mjs` | The end-to-end run against Stripe test mode. |

## Config keys (`data/app-billing.json`)

| Key | Meaning |
|---|---|
| `app_go_live_date` | App go-live, `YYYY-MM-DD` (default `2027-06-01`). Every founding sale's expected start. Moving it later applies the delay credit automatically. |
| `app_subscriptions_open` | `false` until go-live. `/api/subscribe` also refuses before `app_go_live_date`. |
| `default_cadence` | `annual`. |
| `cadences.<name>.loading` | Monthly +8%, quarterly +5%, 6-monthly +3%, annual 0 (Levers tab). |
| `products[]` | `id`, `name`, `monthly_aud`, `per` (account or seat), `needs_trade`. |
| `founding.places_total` | 20. |
| `founding.discount`, `founding.term_months` | 0.15 and 12. |
| `founding.sale_opens_at` | `2027-03-01`. Closed before it. |
| `founding.sale_closes_at` | `null` = closes at `app_go_live_date`. |
| `founding.reservation_minutes`, `checkout_session_minutes` | 35 and 30: a place is held for the Stripe session's life plus a margin. |
| `founding.refund_reopens_place` | `false`: a refunded place does not go back on sale. |
| `founding.create_renewal_subscription` | `true`: see "Renewal" below. |
| `founding.delay_credit` | 1 month per month of delay; part months round up. |
| `founding.long_stop_date` | `null`. PLACEHOLDER for the solicitor's long-stop date (question 28). When set, sales whose start passes it are flagged `long_stop_passed`; nothing is refunded automatically. |
| `founding.forms_pack_grant` | The matching FORMS pack per product (below). |
| `checkout_notice.*` | `terms_version`, `price_rise_clause_version`, `price_rise_clause_text`, `founding_notice_text`, `subscription_notice_text`. Shown on the Stripe page (`custom_text.submit`) and returned by `/api/founding/status`. All marked PENDING SOLICITOR. |

## Matching FORMS pack

| App product | FORMS pack granted |
|---|---|
| Trade package Domestic | the buyer's Trade Compliance pack, `compliance:<TRADE>` (SWMS and ITPs) |
| Trade package Light Commercial | `subcontractor:<TRADE>:light-commercial` |
| Trade package Heavy Commercial | `subcontractor:<TRADE>:heavy-commercial` |
| Builder bundle Domestic / Light / Heavy | `builder:domestic` / `builder:light-commercial` / `builder:heavy-commercial` |
| AUDIT seat | `addon:audit` (Audit Management Pack) |

Where the trade has no sellable pack at that level, the next level down is
used, then the trade's compliance pack. The grant goes to SiteGuard FORMS
through the existing storefront-orders intake as an A$0 order with
`option: "founding-grant"`.

## HTTP interface

CORS is open to the `LEAD_ALLOWED_ORIGINS` (the Systems website).

| Method and path | Body / answer |
|---|---|
| `GET /api/app/prices` | The line-up with every cadence price and the founding price, in cents ex GST. |
| `GET /api/founding/status` | `{ open, closed_reason, places_total, places_sold, places_reserved, places_remaining, sale_opens_at, sale_closes_at, app_go_live_date, discount, term_months, long_stop_date, notice }` |
| `GET /api/founding/places` | `{ remaining, total, sold, open }`. The FORMS site's `data/site-mode.json` `founding_places_api` points here. |
| `GET /api/founding/feed` | Control Console feed: `{"figures": {"founding_places_sold": {"YYYY-MM": n}, "founding_places_remaining": {"YYYY-MM": n}}}`. Also written to `var/founding/founding-feed.json`. Set `SITEGUARD_FOUNDING_PLACES_FEED` to either. |
| `POST /api/founding/checkout` | `{ productId, trade?, quantity? (seats), acceptedTerms: true, termsVersion, email? }` -> `{ ok, url, session_id, reservation_expires_at, places_remaining }`. 409 with a reason when closed, sold out, or the terms version is stale. |
| `POST /api/founding/checkout/cancel` | `{ session_id }`: expires the Stripe session and releases the place at once. |
| `POST /api/subscribe` | `{ productId, trade?, quantity?, cadence? (annual default), acceptedTerms: true, termsVersion }` -> `{ ok, url, session_id }`. 409 `APP_NOT_OPEN` before go-live. |
| `GET /api/founding/admin/sales` | Bearer `FOUNDING_ADMIN_TOKEN`. Every sale record (the P7 founding import reads this). 404 when the token is unset. |
| `POST /api/founding/admin/refund` | `{ sale_id, reason }`: refunds the unused prepayment to the card, cancels the renewal, records it. |
| `POST /api/founding/admin/apply-go-live` | Re-applies the configured go-live (normally automatic). |

Webhook (`/api/webhook/stripe`, the existing route): `checkout.session.*`
events whose session `metadata.kind` is `founding` or `app_subscription` are
handled here; everything else goes to the FORMS one-off flow as before.

## Race safety (20 places, never 21)

A place is reserved when the Stripe session is created, inside a single
in-process queue, and counts against the stock until the sale is confirmed or
the reservation is released (Stripe `checkout.session.expired`, the cancel
route, or its own 35-minute TTL). `sold + held <= 20` always. One storefront
process owns the ledger; running two processes needs a database lock first.
A payment that arrives after its reservation lapsed is still recorded (the
customer has paid) and flagged `oversold` for Dan.

## Sale record (`var/founding/ledger.json`, `sales[]`)

`sale_id`, `status` (active, partially_refunded, refunded), `oversold`,
`stripe_session_id`, `stripe_customer_id`, `stripe_payment_intent_id`,
`stripe_subscription_id`, `app_product_id`, `app_product_name`, `trade`,
`quantity`, `currency`, `list_price_cents_ex_gst`, `discount`,
`price_paid_cents_ex_gst`, `gst_cents`, `amount_paid_total_cents`, `paid_at`,
`original_expected_start_date`, `expected_start_date`, `term_months`,
`service_end_date`, `terms_version`, `price_rise_clause_version`,
`notice_status`, `forms_pack {pack_id, granted_at, intake}`,
`delay_credits [{months, from_start, to_start, applied_at, basis}]`,
`refunds [{kind, amount_cents, stripe_refund_id, stripe_status, reason, at, as_of}]`,
`long_stop_passed`, `customer {email, business_name, address}`.

## Renewal

At purchase a Stripe subscription is created at the STANDARD annual price
with a trial that ends at `service_end_date` (12 months from go-live plus any
delay credit), on the card used for the prepayment. A delay credit moves the
trial end; a refund cancels it. After the founding year Stripe renews at the
standard price. Stripe's renewal reminder email must be switched on in the
dashboard before live.

## Refund of the unused prepayment

Before the service starts: everything paid (GST included). After: the unused
share of the 12 paid months, pro rata by day; free delay-credit months never
reduce it. Method and wording PENDING SOLICITOR (question 28).

## Customer email

None is sent. Confirmation, delay-credit and refund notices are logged to
`var/mail-events.jsonl` as `stub: true` until the approved wording exists.

## Running

```
STRIPE_SECRET_KEY=sk_test_... node scripts/sync-app-stripe.mjs --audit-gated
STRIPE_SECRET_KEY=sk_test_... FORMS_STRIPE_MAP=<SiteGuard-Forms>/app/server/data/pack-catalog-stripe.test.json \
  node test/e2e/stripe-test-mode.mjs
```

## Two sites, one engine (WP-S9 / WP-S10)

`lib/engine-origins.js`. The storefront is the one checkout engine for siteguardforms.com.au and siteguardsystems.com.au.

- **Origins.** `CHECKOUT_ALLOWED_ORIGINS` (default: `LEAD_ALLOWED_ORIGINS`, the Systems site's two origins) may call `/api/checkout`, `/api/founding/checkout` and `/api/subscribe` cross-origin (CORS on these routes; any other origin gets 403, preflight included).
- **returnOrigin.** Each of the three routes takes an optional `returnOrigin`. It must be the storefront or an allowed origin, and on a cross-origin call it must be the caller's own origin; it defaults to the caller's origin. Stripe's `success_url` / `cancel_url` are built on it: `/order/success/`, `/order/cancelled/` (FORMS one-off); `/founding/success/?session_id={CHECKOUT_SESSION_ID}`, `/founding/cancelled/?session_id={CHECKOUT_SESSION_ID}` (founding); `/app/success/`, `/app/cancelled/` (subscriptions). The Systems site has all six pages.
- **source_site.** `forms` or `systems`, worked out from the return origin (a `source_site` in the body must agree), written to every session's metadata (with `return_origin`), to `orders.jsonl` (`sourceSite`), the founding sale and `app-subscriptions.jsonl`.
- **Gates (all must say yes; any one closes the sale):**

  | Sale | Site (`data/site-mode.json` `app_status`) | P2 (`data/app-billing.json`) | Platform (P7) |
  |---|---|---|---|
  | Founding place | `presale` | founding window open (`sale_opens_at` to `sale_closes_at` / go-live) and places left | not asked |
  | App subscription | `live` | `app_subscriptions_open` true (kept as an extra off-switch) and today >= `app_go_live_date` | `GET APP_LAUNCH_URL` (AUDIT API `/api/platform/launch`) answers 200 within 5 s with `appGoLive: true`; cached up to 5 minutes |

  Where they disagree the sale stays closed and the disagreement is listed in `gate_disagreements` on `/api/founding/status` and `/api/app/prices`, and logged at start-up. `app_status` here and in siteguard-website's `data/site-mode.json` are switched together (same field, same values); the engine's copy is the one that decides.
- **Webhook routing** (`classifySession`): the session's `metadata.kind` first, then line metadata (`packageId` / `documentCode`: FORMS one-off; `app_product_id` / `appPlan`: app plan; `cadence: founding`: founding). A session mixing FORMS and app lines goes to `orders-needing-review.jsonl` and is not fulfilled. App subscriptions are recorded in `app-subscriptions.jsonl` (`for_dan: true`) and logged; no email is sent.
- **Webhook URL.** The route is `/api/webhook/stripe`. The Stripe test-mode endpoint must point there (not `/api/billing/webhook`).
