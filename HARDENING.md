# Hardening: SiteGuard FORMS storefront

Each row of websites brief Rev02 WP5, and what proves it. "CI" means
`.github/workflows/ci.yml` runs it on every pull request.

| Area | Requirement | Where it is checked |
|---|---|---|
| Links | Every internal link resolves | `scripts/build-site.mjs` fails the build on a broken link (CI) |
| Error pages | Real 404 and 500 pages | `dist/404.html`, `dist/500.html`; served by the fallback and error handlers in `lib/create-app.js` |
| SEO | `sitemap.xml`, `robots.txt`, canonical tags, unique title and description per page, Open Graph | built by `build-site.mjs`; `test/build.test.js` (CI) |
| Structured data | `Organization`, `Product` / `Offer` (ex GST), `BreadcrumbList`, `FAQPage` | JSON-LD in `build-site.mjs` |
| Accessibility | Skip link, visible focus, labels on every field, no sideways scroll at 360 px | `test/build.test.js` (skip link); `test/e2e/run.mjs` (360 px, menu) (CI) |
| Lighthouse | Performance ≥ 90, Accessibility ≥ 95, Best Practices ≥ 90, SEO ≥ 95 | run against the preview URL before go-live; pages are static, self-hosted fonts, no third-party scripts |
| Page weight | Under 100 KB of HTML per page | build fails above 100 KB (CI); long document lists load on demand |
| Functions | Cart on every page, test-card checkout, enquiry form, no console errors | `test/e2e/run.mjs` in a real browser (CI); `test/app.test.js` |
| Prices | Every price equals the catalogue, which equals `packages.py` | server re-prices every line (`test/app.test.js`); `test/build.test.js`; Hseq-Dev `tests/test_build_catalogue.py` |
| What is sold | Only released packs; no OFSC; no ISO / OFSC rung; nothing quoted; preview never takes payment | `test/app.test.js`, `test/build.test.js`, Hseq-Dev `tests/test_build_catalogue.py` |
| Banned words | `compliant`, `certified`, `endorsed`, `guarantee`, `4801`, `coming soon`, `rolling out`, `in progress`, `quarterly` (legal pages exempt) | build fails (CI); `test/build.test.js` |
| Legal | Legal pages from the one source; production build refuses open `[placeholders]`; checkout needs the SG-LEGAL-06 tick box, recorded on the order | `build-site.mjs --production`; `test/app.test.js` |
| Security headers | CSP (`default-src 'self'`, no inline script or style), HSTS, `frame-ancestors 'none'` / `X-Frame-Options`, Referrer-Policy, Permissions-Policy | `lib/create-app.js`; `test/app.test.js`; `test/build.test.js` (no inline script or style) |
| Stripe | Webhook signature checked; events processed once; Stripe Tax on; test mode until Dan approves | `test/app.test.js` |
| Abuse | Rate limits on `/api/checkout` (20 / 10 min) and `/api/lead` (5 / 10 min); honeypot field; JSON body limits; CORS on `/api/lead` for siteguardsystems.com.au only | `test/app.test.js` |
| Secrets | None in the client bundle or the repo; `.env` ignored | static site has no keys; `.gitignore` |
| Dependencies | `npm audit`: 0 high or critical | CI (`npm audit --omit=dev --audit-level=high`) |
| Node | Pinned | `.nvmrc` (20), `engines` in `package.json` |
