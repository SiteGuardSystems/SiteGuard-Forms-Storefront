# Go-live check: SiteGuard FORMS storefront (S5)

Go-live brief Rev02 (7 Nov 2026), Section 6, Session 3, task **S5**. Checked Saturday night 7 Nov 2026 against the built site of the top of tonight's stack (branch `s3-sellable-list`, which holds S1, S2 and S3): `npm run build`, **71 pages**, `beta: true`. Report only: nothing deployed, no switch flipped, no live Stripe, no email sent.

## 1. Tonight's PRs and merge order

| Order | PR | Task | Base | What |
|---|---|---|---|---|
| 1 | [#40](https://github.com/SiteGuardSystems/SiteGuard-Forms-Storefront/pull/40) | S1 | `master` | "Delivered as PDFs by email within 3 business days" everywhere; intake link on the success page and in the receipt; fast-delivery words fail the build |
| 2 | [#41](https://github.com/SiteGuardSystems/SiteGuard-Forms-Storefront/pull/41) | S2 | stacked on #40 | FORMS switches read with the intake key (fail closed); checkout refused while `sales_open` is off; Subscribe buttons hidden behind "Coming soon: register interest" (to `/api/lead`, tag `forms-interest`) |
| 3 | [#42](https://github.com/SiteGuardSystems/SiteGuard-Forms-Storefront/pull/42) | S3 | stacked on #41 | Only the 72 packs on the Rev01 sellable-now list are shown or sold; delivery line and disclaimer summary on every pack |
| 4 | [#43](https://github.com/SiteGuardSystems/SiteGuard-Forms-Storefront/pull/43) | S5 | stacked on #42 | This report (stacked so its CI runs on the checked stack; see below) |
| none | none | S4 | none | Nothing built: "+GST" kept (Q2 unanswered) |

S1 to S3 are stacked because each changes the shared shop file and the built-site snapshot fixture. Merge #40, then #41, then #42, then #43 (GitHub retargets each to `master` when the one below merges). `master`'s own CI has been red since about 6 Nov: the built-site snapshot pinned the planning pages, which drop past events every day. #40 stops pinning them, so CI is green from #40 on. After merging, copy `scripts/lib/shop.mjs`, `cart.mjs` and `cart-browser.js` to siteguard-website (they are kept identical in both repos).

## 2. `beta` and the switches

- `data/site-mode.json` `beta` is **true** on `master` and on every PR tonight (#40, #41, #42 and this one). Dan sets it false at Gate L4.
- With S2 merged, the storefront also needs FORMS to say `sales_open` before it opens a Stripe Checkout. No FORMS URL or key, an error or a bad answer reads as everything off.
- Subscriptions (S4) and consultant plans (S5) are off: their buttons show "Coming soon: register interest" until FORMS says otherwise.

## 3. Pages that mention delivery, subscriptions, the app or prices (wording after S1 to S3)

| Page(s) | Topic | Wording after the change |
|---|---|---|
| `/` (home) | Delivery | "Send us your business and project details, and the documents are delivered as PDFs by email within 3 business days." "Buy outright. Pay once. The documents are filled with your business and project details, checked by our team and emailed to you as PDFs within 3 business days of your details being in." |
| `/` (home) | Subscriptions | "How to buy … Subscriptions and consultant plans. Not on sale yet. Coming soon: register interest." |
| `/` (home) | Prices | "From $479 +GST, 57 packages" (trade packs); "From $479 +GST, 15 packages" (specialist packs). Builder packs and management systems no longer appear under "Choose a range" (all held, see S3). Counts: 759 documents, 214 SWMS, 26 trade and specialist packs |
| 26 trade and specialist pack pages (`/trade-packs/<trade>/`, `/specialist-packs/<trade>/`) | Delivery | On each level: "The current revision, filled with your details. Delivered as PDFs by email within 3 business days." and "Delivered as PDFs by email within 3 business days. The 3 business days start when your details are in (a short form after payment)." Under the levels: "Buying outright: after payment you send us your business and project details on a short form, and the documents are filled with them and emailed to you as PDFs within 3 business days of your details being in." "How a pack works": "Your details in … PDFs out: … checked by our team and emailed to you as PDFs within 3 business days of your details being in" |
| Same pages | Disclaimer | On each level: "Templates aligned to Australian WHS laws, reviewed 6-monthly. The business using them must review and adapt each document to its own work and site, consult its workers and keep it current; it keeps responsibility for its safety obligations. Document Use Disclaimer." |
| Same pages | Subscriptions | Annual price shown with "Coming soon: register interest" in place of "Subscribe yearly"; the monthly line and "Subscribe monthly" are hidden; "Subscriptions: Coming soon: register interest." No subscription offer in the product JSON-LD |
| Same pages | Prices | "One-off purchase $539 +GST" (and so on, from the catalogue); "Prices in A$, excluding GST. GST is added at checkout." |
| `/trade-packs/`, `/specialist-packs/` | Prices | "From $… +GST, one-off purchase" per trade. Masonry and Tiling are gone until the held entries land |
| `/builder-packs/`, `/management-systems/` | Listing | "No builder packs / management systems are available to buy right now. Tell us what you need and we'll reply within one business day." (every pack in these groups is blocked by a held Rev24 entry) |
| `/documents/` | Delivery, prices | "Each document is $44 +GST, bought outright." "Delivered as PDFs by email within 3 business days. The 3 business days start when your details are in (a short form after payment)." Held documents and documents not on the list are not offered |
| `/subscriptions/` | Subscriptions | "Subscriptions and consultant plans aren't on sale yet. Coming soon: register interest below and we'll email you when they open. Until then, every pack can be bought outright and is delivered as PDFs by email within 3 business days." Register-interest form (name, email, company, phone, interested in, optional note, consent box). "What a subscription includes" and "Billing" are kept as a description, including "Subscriptions renew automatically." |
| `/how-ordering-works/` | Delivery | Steps: choose, pay securely (Stripe; business name and project address), "Send us your details" (link after payment and in the order email), "Receive your documents: … within 3 business days of your details being in." Subscriptions column: "… aren't on sale yet. Coming soon: register interest" |
| `/faq/` | Delivery, subscriptions, prices | "How quickly will I get them? Delivered as PDFs by email within 3 business days. The 3 business days start when your details are in …" "Can I subscribe instead? Not yet: … Coming soon: register interest …" "Prices exclude GST. GST is calculated and added at checkout …" |
| `/cart/` | Delivery, prices | Above the checkout notice: "Delivered as PDFs by email within 3 business days. The 3 business days start when your details are in (a short form after payment)." Under the subtotal: "GST is added at checkout … Delivered as PDFs by email within 3 business days of your details being in." The SG-LEGAL-06 notice is unchanged (see item 2 in Section 5) |
| Stripe Checkout page | Delivery | Submit message: "Delivered as PDFs by email within 3 business days. After payment you'll get a short form for your business and project details; the 3 business days start when your details are in." |
| `/order/success/` | Delivery, intake | "We've emailed your receipt. Next, tell us your business and project details …" plus the "Enter your details" button(s) from FORMS' `intakeUrl`, and "Delivered as PDFs by email within 3 business days. The 3-business-day clock starts when your details are in." |
| Receipt email (not a page) | Delivery, intake | The intake link(s), then "Your documents are delivered as PDFs by email within 3 business days. The 3-business-day clock starts when your details are in." |
| Every page (header, footer) | Prices, app | Footer: "Prices are in A$ and exclude GST (+GST)." Footer link "Subscriber sign in" to the FORMS app login (see item 4 in Section 5). No mention of the app modules, CORE, SiteGuard AI, robotics, overseas markets or the founding offer (`app_status` is `coming_soon`, so the founding panel is off; the build fails on the gated words) |
| `/planning/…`, `/education/…` | None | "Subscribe on YouTube" and "Subscribe instead of downloading" (calendar feeds) only: not FORMS subscriptions |
| Legal pages | None | Unchanged; they come from the SiteGuard-Forms legal source (items 1 to 3 in Section 5) |

Checks that now run on every build: no "instant", "within minutes", "download now" or similar on any non-legal page; "coming soon" only as "Coming soon: register interest"; every page selling a pack shows the delivery line; no visible Subscribe link while S4/S5 are off.

## 4. Broken links

**None.** The build's own check (every internal `href` resolves) passed, and an independent scan of the 71 built pages for every internal `href`, `src` and lazy document list (`data-lazy-docs`) found 0 broken. `/builder-packs/` and `/management-systems/` still exist (with their empty state), so the header links to them resolve.

## 5. Open items and questions for Dan (yes/no)

1. **Terms of Sale delivery clause.** It says documents are emailed "usually within minutes" and checked "usually within 1 business day". It comes from the SiteGuard-Forms legal source (solicitor-controlled), so it is unchanged here. *Change it to "within 3 business days of your details being in" in the Forms legal source (with the solicitor), then sync?* Yes/no.
2. **Checkout notice (SG-LEGAL-06)** says "Subscriptions renew automatically until cancelled", shown in the cart while subscriptions are off. *Leave it until the next legal sync?* Yes/no.
3. **Refunds page** gives hello@siteguardsystems.com.au for refund requests. *Switch it to support@ once `SUPPORT_EMAIL` is set (Forms legal source)?* Yes/no.
4. **"Subscriber sign in"** in the footer links to the FORMS app login while no subscription is sold. *Hide it until S4 is on?* Yes/no.
5. **Two order emails.** The buyer gets the storefront receipt (with the intake link) and FORMS' own order confirmation (with the same link). *Keep both?* Yes/no.
6. **Builder packs and management systems pages** show "not available to buy right now" until the held Rev24 ledger entries land. *Keep them in the menu meanwhile?* Yes/no.
7. **SLA days.** The pages say "3 business days" as built text, and the receipt uses 3 too. If switch S3 is set to another number, the pages need a rebuild with the new number. *OK to keep 3 fixed in the page text?* Yes/no.
8. **Q2 GST (task S4).** "+GST" is kept everywhere and Stripe Tax stays on (`STRIPE_AUTOMATIC_TAX`). *Is SiteGuard registered for GST?* Must be answered before Gate L4.
9. **Pricing Rev08.** The sellable list uses the Rev08 tables, which `packages.py` dates effective 1 Mar 2027; the catalogue here is stamped Pricing Rev06 with the same numbers. *Sell one-off packs now at these prices?* Yes/no (also in the list's own Section 5).

## 6. What Dan must do (no code)

- Merge #40, #41, #42 and #43 in that order.
- Deploy FORMS #98 (the switches endpoint) before or with the storefront: without it every switch reads as off and checkout stays closed (on purpose).
- No new storefront env key is required. Optional: `FORMS_SWITCHES_URL` (defaults to the `ORDER_INTAKE_URL` host). Existing: `ORDER_INTAKE_URL`, `ORDER_INTAKE_API_KEY` (must match FORMS `STOREFRONT_ORDER_INTAKE_API_KEY`), `SUPPORT_EMAIL`.
- After the Hseq-Dev ledger PR lands and the catalogue is regenerated: `node scripts/import-sellable-list.mjs <Rev02 list CSV>` (81 packs), rebuild, PR.
- At Gate L4: set `beta` to false in `data/site-mode.json`, rebuild and restart; then turn on `forms.sales_open` in the Console.
