# SiteGuard FORMS — storefront

Public landing page + Stripe checkout for self-serve HSEQ document purchases.
Turns the "Coming Soon — Register Your Interest" FORMS teaser on
siteguardsystems.com.au into an actual, buyable product.

**Deliberately a separate app from `SiteGuard-Artifact-Factory`.** Different
trust boundary: this process is public-internet-facing and takes payments; it
has no SharePoint/Graph credentials, no factory database access, and no code
path into the internal ops tool. The only thing it shares with the Artifact
Factory is the idea of the document library — not a network connection to it.

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

## What's real vs. stubbed

| Piece | Status |
|---|---|
| Landing page, brand, copy | Built — matches siteguardsystems.com.au's palette (`#FB811C` / `#FFFBF7` / Barlow Condensed + Nunito) and the existing FORMS section's framing |
| Package catalog (`packages.json`) | **Draft placeholder pricing** — needs your sign-off before anything charges a real customer |
| Stripe Checkout | Wired (`stripe.checkout.sessions.create`, redirect flow) — needs a real `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` |
| Order/lead logging | Appends JSON lines to `var/orders.jsonl` / `var/leads.jsonl` — fine for launch volume, not a real CRM |
| **Fulfillment** (actually delivering the purchased document) | **Not built.** The webhook handler has a marked extension point (`server.js`, `TODO(fulfillment)`) but sending files needs a decision on delivery mechanism, and a hard rule that only QA-clean documents are ever attached to a paid order — see below |

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
5. **Fulfillment** — how does a paying customer actually receive the file?
   Options, roughly in order of effort:
   - Manual for now: webhook emails you the order, you send the DOCX by hand
     (fine at launch volume, zero extra build).
   - Signed download link generated at webhook time, pointing at a copy of
     the file already confirmed QA-clean (per the Artifact Factory's
     `library_snapshot.json` — **only 96 of 1,354 library documents are
     currently marked `clean`**; the rest are `reported_only`, `blocked`, or
     `working_material` and should not be sold as finished controlled
     documents yet).
   - Full self-serve portal later, once volume justifies it.
6. **Legal** — terms of sale, refund policy, and the same "SiteGuard does not
   guarantee certification/audit outcomes" disclaimer the parent site
   carries (already echoed in this page's footer) reviewed for an actual
   point-of-sale context, not just a consulting enquiry.

## On removing HITL over time

The Artifact Factory's own Organisation snapshot is explicit that its human
review gates ("acts that never automate") are how the business is governed,
not incidental friction. Automating *sales* of already-QA-cleared documents
(this app) is a different, safer step than automating the *QA clearance*
itself. Worth treating those as two separate roadmaps: this storefront can
mature quickly since it never touches an un-reviewed document; loosening the
QA/HITL gates on document *production* is a bigger, slower decision that
deserves its own explicit review per gate, not a side effect of this launch.
