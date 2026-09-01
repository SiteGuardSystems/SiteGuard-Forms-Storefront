# SiteGuard FORMS — storefront

Public landing page + Stripe checkout for HSEQ document orders. Turns the
"Coming Soon — Register Your Interest" FORMS teaser on siteguardsystems.com.au
into an actual order form.

**Deliberately a separate app from `SiteGuard-Artifact-Factory`.** Different
trust boundary: this process is public-internet-facing and takes payments; it
has no SharePoint/Graph credentials and no factory database access. The one
door between them is narrow and one-way: a completed order calls the
factory's `POST /api/storefront-orders` (a shared API key, not the same
credential as anything Graph/SharePoint) — see "The purchase model" below.

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
calls the Artifact Factory's `storefront-orders` route, which creates a
normal `ArtifactJob` at `REGISTERED`. From there it's the same lifecycle
every other job goes through — `READY_FOR_REVIEW` is where it waits for a
human, `APPROVED` is mastering, `RELEASED` is delivery. This app never
generates or delivers a document itself.

This repo previously had a Stripe *Subscription* option and a self-serve
project-credit ledger with magic-link redemption. That was built before
`ORDER_SITE.md` was found, directly contradicts it, and has been removed —
see git history if a subscription model is ever revisited (only after the
cloud migration the doc names).

## What's real vs. stubbed

| Piece | Status |
|---|---|
| Landing page, brand, copy | Built — matches siteguardsystems.com.au's palette (`#FB811C` / white / Barlow Condensed + Helvetica Neue + Nunito wordmark) and the real shield logo |
| Package catalog (`packages.json`) | **Draft placeholder pricing** — needs your sign-off before anything charges a real customer |
| Stripe Checkout | Wired — one-off payment only, `custom_fields` collect the project address/client name/site notes on Stripe's own page |
| Order → Job | Wired — `checkout.session.completed` calls the Artifact Factory's `storefront-orders` route, creating a real `ArtifactJob`. Verified live end-to-end. |
| Order confirmation email | Wired via Resend — needs a real `RESEND_API_KEY` |
| **Everything past `REGISTERED`** | **Manual, on purpose.** Mastering, QA, approval, and delivery all happen exactly as they do for any other job — this app has no more automation to add there without revisiting `ORDER_SITE.md`'s own reasoning first |

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
4. **Pricing sign-off** — everything in `packages.json` is a placeholder
   guess. Needs Daniel's numbers, and a call on GST registration/inclusion.
   `ORDER_SITE.md` explicitly leaves catalogue units (individual documents,
   trade packs, or whole-system bundles) undecided — this isn't blocking.
5. **Turnaround promise** — `ORDER_SITE.md`: *"Taking money before
   delivering makes turnaround a promise... state the turnaround on the
   order page and make it one you can hit on your worst week."* Not on the
   page yet.
6. **familyCode/documentCode mapping** — `storefront-orders.ts` currently
   uses a fixed `familyCode: "STOREFRONT"` and the storefront's own
   `packageId` as `documentCode`, because there's no real mapping yet from
   storefront packages to the DCRN register. Fine for now (jobs are still
   identifiable and reviewable), but worth a proper mapping before volume.
7. **Legal** — terms of sale, refund policy, and the same "SiteGuard does not
   guarantee certification/audit outcomes" disclaimer the parent site
   carries (already echoed in this page's footer) reviewed for an actual
   point-of-sale context, not just a consulting enquiry.
