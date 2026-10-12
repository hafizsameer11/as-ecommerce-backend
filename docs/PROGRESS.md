# Progress — the living plan

Updated every time a module lands in `D:\projects\asl-orginals\asl-backend`. If Claude stops mid-way
(usage limit), this file says exactly where things stand and what to do next, so work can continue by hand.

- Full design: [`BACKEND_PLAN.md`](BACKEND_PLAN.md) (section 5 = every module's endpoints, section 9 = every screen → endpoint)
- How code is written: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Business rules and open questions: [`DECISIONS.md`](DECISIONS.md)
- Live API docs: `npm run dev` → http://localhost:4000/docs

## Status by module

Legend: ✅ done + tested · 🟡 in progress · ⬜ not started

| Area | Module (folder under `src/modules/`) | Status | Notes |
|---|---|---|---|
| Identity | identity/auth, account, admin-auth, team | ✅ | password, OTP, 2FA, sessions, RBAC |
| Identity | identity/customers (admin) | ✅ | block, tier, notes, tags, wallet adjust, anonymise |
| Platform | platform/settings, audit, addresses | ✅ | one source of truth for business rules |
| Catalog | catalog/* (products, categories, brands, collections, size-guides, reviews, search, home) | ✅ | |
| Catalog | catalog/drops (+ reservations, deposits) | ✅ | |
| Inventory | inventory | ✅ | row-locked reserve/commit/release |
| Commerce | commerce/carts (+ abandoned carts), wishlist, coupons, checkout, orders | ✅ | |
| Commerce | commerce/returns, documents (PDF), draft-orders | ✅ | |
| Fulfilment | fulfilment/shipping-zones, tax, pickups (locations + bookings), shipments | ✅ | |
| Payments | payments/payments (mock gateway), wallets, payment-methods, ledger, payouts | ✅ | |
| Loyalty | loyalty/club, referrals | ✅ | |
| Concierge | concierge/requests, quotes, chat, suppliers | ✅ | chat is polling, no websocket yet |
| Support | support/tickets, feedback | ✅ | SLA by priority, internal notes, tags, assign |
| Support | support/notifications (customer inbox + preferences) + staff bell + notification-settings | ✅ | `notify()` and `notifyStaff()` helpers |
| Marketing | marketing/messaging admin (templates, push blasts) | ✅ | |
| Marketing | marketing/segments, campaigns | ✅ | open/click tracking, unsubscribe; segment coupons now work |
| Marketing | marketing/banners, announcements, slots (+ impressions) | ✅ | seeded from the storefront; `/store/home` includes slots |
| Content | content/pages (CMS), faqs, blog, seo (robots, sitemap, redirects), media library API | ✅ | storefront policy pages seeded; business numbers filled from settings |
| Platform | platform/activity feed, app-config (+ consent, app-download offer), global-search | ✅ | |
| Insights | analytics events + rollups, dashboard, analytics screens, reports (CSV/XLSX/PDF, scheduled email) | ✅ | report files stored privately, streamed with auth |
| Hardening | real payment provider, refund/transfer webhooks, websocket chat, S3 storage (if >1 server), backups, monitoring | ⬜ | plan §10, §13 |

## Phase order from here

| Phase | Scope | Status |
|---|---|---|
| 6 | Support (tickets, feedback, notifications centre, staff bell, notification settings) + marketing (templates admin, push blasts, segments, campaigns, banners, announcements, slots) | ✅ |
| 7 | Content (CMS pages, FAQs, blog, SEO, media library) + activity feed, app-config, global search | ✅ |
| 8 | Analytics events + rollups, dashboard, analytics screens, reports | ✅ |
| 9 | Hardening for launch — see list below | 🟡 next |
| — | Frontend wiring: replace each zustand mock store in asl-web / asl-mobile / asl-admin with API calls | ⬜ separate work, not started |

## Remaining backend work (hardening)

1. **Real payment provider** (Paystack or Flutterwave): new class implementing `PaymentProvider` in `src/providers/payment/`, plus webhooks for refunds and transfers (today the mock settles them instantly).
2. **Concierge refunds after payment** (D12) and **concierge cart edit endpoints**.
3. **Websocket chat** (concierge + live admin activity) — today apps poll.
4. **Push preferences everywhere**: older listeners call `messaging.push` directly and ignore customer preferences; route them through `notify()`.
5. **Missing events**: `payout.pending` (payouts sync), `catalog.updated`, club tier upgrade → inbox row.
6. **Unseeded notification rules** the admin UI lists: `order_risk`, `customer_vip`, `finance_payout`, `system_role`, `system_backup`.
7. **Shipping labels PDF / carrier webhooks**, **CSV import of draft orders**, **GET /payouts/providers**.
8. **Ops**: S3/R2 storage driver if more than one server, Redis-backed rate limits, backups, monitoring, load test, admin URL env for links in staff emails.

## How to continue a module by hand

1. Read its section in `BACKEND_PLAN.md` and the matching UI store in `asl-admin/src/lib/*-store.ts` or `asl-web/src/lib/*-store.ts` (types + actions = what the API must offer).
2. Check the Prisma model already exists in `prisma/schema/` (most do).
3. Copy the shape of a finished module (e.g. `src/modules/commerce/coupons/`): `*.schemas.ts` → `*.service.ts` → `*.controller.ts` → `*.routes.ts`.
4. Register the router in `src/modules/index.ts`, listeners in `registerListeners()`, jobs in `src/jobs/schedules.ts`.
5. Write an e2e test in `tests/e2e/`, run `npx tsc --noEmit && npm run lint && npm test`.
6. Tick the row above and add any rule you decided to `DECISIONS.md`.

## Change log
- Phases 0–5 delivered (identity → concierge), 144 e2e tests.
- Phases 7–8: activity feed, app config, consent, app-download offer, global search, analytics ingest + rollups, dashboard, analytics screens, reports. Missing `/uploads/...` files now 404 instead of 500. Private report storage volume added to docker-compose.
- Phase 6 part 2 + content: banners, announcements, slots, impressions; CMS pages, FAQs, blog, SEO, media library. Fixed a cross-cutting bug: PATCH bodies built with zod `.partial()` re-applied create defaults (silently resetting fields) — all now use `patchOf()` from `src/core/http/patch-schema.ts`.
- Phase 6 part 1: support tickets, feedback, customer notification centre, staff bell + notification settings, message templates admin, push blasts, segments, campaigns.
