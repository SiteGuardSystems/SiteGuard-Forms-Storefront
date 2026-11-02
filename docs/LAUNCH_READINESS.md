# Launch readiness: pre-launch checks (queue B9, report only)

Run on 3 Nov 2026, against `main` at `f1ecca0`. Report only: no code changes, no deploy, and no live Stripe.

| # | Check | Result | Evidence | What's left |
|---|---|---|---|---|
| 1 | Checkout end to end in Stripe **test** mode | **Not run** | `npm run test:e2e:stripe` (`test/e2e/stripe-test-mode.mjs`) refuses anything but an `sk_test_`/`rk_test_` key, and CC has no key (Dan sets it himself, #212) | Dan sets `STRIPE_SECRET_KEY=sk_test_…` and `FORMS_STRIPE_MAP=…/pack-catalog-stripe.test.json` in his own shell and runs it. Pass = the script exits 0 |
| 2 | The Document Use Disclaimer goes with every delivery | **Pass (code and tests)** | The storefront hands orders to the FORMS engine. FORMS `server/delivery/service.ts` (`processJob`) builds the disclaimer PDF for **every** set (the white-label version for consultant sets) and logs it. If it can't be made, the set **holds**: "nothing goes out without it". Covered by FORMS `test:delivery-contracts` (`disclaimer-whitelabel`, `generation-log`) | Watch it in the first test-mode order (row 1) |
| 3 | "+GST" on every Rev08 price | **Pass** | `npm test` built the site: 73 pages, 357 price mentions, and **none** without "+GST", "ex GST" or "exclude GST" within 120 characters. The footer on every page says "Prices are in A$ and exclude GST (+GST)". Pricing is pinned by `pricing.lock` | None |
| 4 | `SUPPORT_EMAIL` set | **Can't check from here** | `lib/mailer.js` reads `SUPPORT_EMAIL`, falling back to `hello@siteguardsystems.com.au`. The server's `.env` isn't read (rule) | Dan checks forms-vps has `SUPPORT_EMAIL=` set to the support mailbox he wants on order emails (support@ or hello@). Yes/no in DAN_DECISIONS_PARKED |
| 5 | `beta` and `app_status` read correctly | **Pass (tests)** | `npm test`: 171 tests, 171 pass, 0 fail. This covers the site-mode switch (`data/site-mode.json`: `beta`, `app_status` coming_soon / presale / live, gates in `lib/app-routes.js`, `lib/create-app.js`, `lib/engine-origins.js`) | None |

**Overall:** 3 pass, 1 needs Dan's test key (row 1), and 1 needs a look at the server's environment (row 4). Nothing found that blocks March.
