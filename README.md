# SiteGuard FORMS — storefront

Public landing page + Stripe checkout for HSEQ document orders. Turns the
"Coming Soon — Register Your Interest" FORMS teaser on siteguardsystems.com.au
into an actual order form.

**Deliberately a separate app from `SiteGuard-Forms`.** Different trust
boundary: this process is public-internet-facing and takes payments; it has
no access to SiteGuard-Forms' tenant/customer database or credentials. The
one door between them is narrow and one-way: a completed order calls
SiteGuard-Forms' `POST /api/v3/storefront-orders` (a shared API key, not the
same credential as anything else) — see "The purchase model" below. Was the
Artifact Factory's `storefront-orders` route until 2026-09-05's
consolidation workstream 4 — same shape, new destination, same reasoning
for keeping the two apps apart.

## Run it

```bash
pnpm install   # or npm install
cp .env.example .env
pnpm start     # or npm start
```

Without `STRIPE_SECRET_KEY` set, the site runs fully — packages render, the
enquiry form works — but "Buy Now" buttons show "Coming Soon" and defer to
the enquiry form. That's intentional: this is safe to deploy and demo before
Stripe is wired up.

## The purchase model — purchase and order, not self-serve

Per `docs/ORDER_SITE.md` in the `hseq-dev` repo (2026-08-03, Dan's own
decision): **one-off orders only, no subscriptions, no self-serve credit
packs**, until the whole thing moves to a cloud server. That document's
reasoning is worth repeating here because it shapes everything in this repo:

> Manual fulfilment makes the mastering gate hold by construction... A site
> that takes an order and puts it in front of you before anything leaves
> cannot ship an unapproved document, because you are the delivery mechanism.

So: a customer pays once via Stripe Checkout, and tells us the project
(address, client name, optional site notes) **right there on Stripe's own
hosted page** via Checkout's `custom_fields` — no separate account, no
redemption step, no repeat visits. The webhook then does exactly one thing:
calls SiteGuard-Forms' `storefront-orders` route, which records the order
(pack, option, customer/project details, Stripe session) for manual review.
It does not auto-provision a tenant, grant a licence, or generate a
document — a human reviews the order and delivers by hand, the same
manual-fulfilment model `ORDER_SITE.md` describes above, now recorded in
SiteGuard-Forms instead of the Artifact Factory. This app never generates
or delivers a document itself.

This repo previously had a Stripe *Subscription* option and a self-serve
project-credit ledger with magic-link redemption. That was built before
`ORDER_SITE.md` was found, directly contradicts it, and has been removed —
see git history if a subscription model is ever revisited (only after the
cloud migration the doc names).

## What's real vs. stubbed

| Piece | Status |
|---|---|
| Landing page, brand, copy | Built — matches siteguardsystems.com.au's palette (`#FB811C` / white / Barlow Condensed + Helvetica Neue + Nunito wordmark) and the real shield logo |
| Package catalog (`packages.json`) | Real prices, rebuilt 2026-09-04 off `docs/packages.py`'s four-rung ladder — still needs G2 (Founder) sign-off before anything charges a real customer |
| Stripe Checkout | Wired — one-off payment only, `custom_fields` collect the project address/client name/site notes on Stripe's own page |
| Order → recorded for review | Wired — `checkout.session.completed` calls SiteGuard-Forms' `storefront-orders` route. Verified live end-to-end. |
| Order confirmation email | Wired via Resend — needs a real `RESEND_API_KEY` |
| **Everything past that** | **Manual, on purpose.** Mastering, QA, approval, and delivery all happen by hand — this app (and SiteGuard-Forms' intake) has no more automation to add there without revisiting `ORDER_SITE.md`'s own reasoning first |

## Before this can actually go live

1. **Domain/DNS** — `www.siteguardforms.com.au` is registered; still needs to
   be pointed at wherever this runs, with TLS.
2. **Hosting decision** — small Node app, runs anywhere (VM2 alongside the
   Artifact Factory as a sibling systemd service, or a PaaS like
   Render/Railway/Fly). Recommend *not* the same VM2 process group as the
   factory API/worker without separating the service account, since a public
   web app and a service holding Graph credentials shouldn't share a blast
   radius.
3. **Stripe** — a real (not test-mode) Stripe account, business details
   verified, `STRIPE_SECRET_KEY` + a webhook registered against the live
   domain for `STRIPE_WEBHOOK_SECRET`.
4. **Pricing sign-off** — `packages.json`'s prices are real (from
   `docs/packages.py`'s ladder, not a guess), but still need Daniel's G2
   sign-off before they're live, and a call on GST registration/inclusion.
   `ORDER_SITE.md` explicitly leaves catalogue units (individual documents,
   trade packs, or whole-system bundles) undecided — this isn't blocking.
5. **Turnaround promise** — `ORDER_SITE.md`: *"Taking money before
   delivering makes turnaround a promise... state the turnaround on the
   order page and make it one you can hit on your worst week."* Not on the
   page yet.
6. ~~familyCode/documentCode mapping~~ — resolved by the 2026-09-05 move to
   SiteGuard-Forms: `storefront_orders` records `packageId`/`packageName`
   directly, no DCRN-register mapping needed at intake time. The old
   Artifact Factory `ArtifactJob` model (and its `familyCode: "STOREFRONT"`
   placeholder) is no longer in the order path at all.
7. **Legal** — terms of sale, refund policy, and the same "SiteGuard does not
   guarantee certification/audit outcomes" disclaimer the parent site
   carries (already echoed in this page's footer) reviewed for an actual
   point-of-sale context, not just a consulting enquiry.
