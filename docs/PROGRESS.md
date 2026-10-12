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
| Hardening | Paystack + async webhooks ✅, websockets ✅, preferences ✅ · outbox for gateway calls, S3, backups, monitoring ⬜ | 🟡 | see list below |

## Phase order from here

| Phase | Scope | Status |
|---|---|---|
| 6 | Support (tickets, feedback, notifications centre, staff bell, notification settings) + marketing (templates admin, push blasts, segments, campaigns, banners, announcements, slots) | ✅ |
| 7 | Content (CMS pages, FAQs, blog, SEO, media library) + activity feed, app-config, global search | ✅ |
| 8 | Analytics events + rollups, dashboard, analytics screens, reports | ✅ |
| 9 | Hardening for launch — see list below | 🟡 next |
| — | Frontend wiring: replace each zustand mock store in asl-web / asl-mobile / asl-admin with API calls | ⬜ separate work, not started |

## Remaining backend work (hardening)

Done:
- ✅ Paystack adapter (`PAYMENT_PROVIDER=paystack`, keys in `.env`) + async refund/transfer webhooks; mock stays the dev default (refused in production unless `ALLOW_MOCK_PAYMENTS=true`)
- ✅ Concierge refunds after payment; `GET /admin/payouts/providers`; failed-refund retry
- ✅ Websockets (socket.io at `/socket.io`): chat, tickets, inbox, staff bell, live activity, order status — rooms/events listed at the top of `src/core/realtime/realtime.ts`
- ✅ Push/SMS follow customer preferences everywhere (transactional email always sends)
- ✅ Missing events (`payout.pending`, `catalog.updated`, `club.tier_upgraded`) and the 5 missing staff rules; `ADMIN_URL` for staff-email links

Still to do:
1. **Gateway calls inside DB transactions** — `paymentsService.refund` calls the gateway inside the caller's transaction; if a later step fails, the gateway has refunded but our rows roll back. Fix: write the Refund row as `pending` in the transaction and send it to the gateway from a job after commit (outbox pattern).
2. **Concierge cart edit endpoints**, **shipping label PDFs / carrier webhooks**, **CSV import of draft orders**.
3. **Ops**: S3/R2 storage driver if more than one server, Redis-backed rate limits, backups, monitoring, load test.
4. Decisions waiting on the business: see "Open business decisions" in `DECISIONS.md` (point value, drop deposit %, gift cards, sale-item returns …).

## How to continue a module by hand

1. Read its section in `BACKEND_PLAN.md` and the matching UI store in `asl-admin/src/lib/*-store.ts` or `asl-web/src/lib/*-store.ts` (types + actions = what the API must offer).
2. Check the Prisma model already exists in `prisma/schema/` (most do).
3. Copy the shape of a finished module (e.g. `src/modules/commerce/coupons/`): `*.schemas.ts` → `*.service.ts` → `*.controller.ts` → `*.routes.ts`.
4. Register the router in `src/modules/index.ts`, listeners in `registerListeners()`, jobs in `src/jobs/schedules.ts`.
5. Write an e2e test in `tests/e2e/`, run `npx tsc --noEmit && npm run lint && npm test`.
6. Tick the row above and add any rule you decided to `DECISIONS.md`.

## Change log
- Phases 0–5 delivered (identity → concierge), 144 e2e tests.
- Hardening 1: Paystack adapter, async refunds/transfers, concierge refunds, payouts providers, socket.io realtime, preference-aware push/SMS, missing events + staff rules, ADMIN_URL.
- Phases 7–8: activity feed, app config, consent, app-download offer, global search, analytics ingest + rollups, dashboard, analytics screens, reports. Missing `/uploads/...` files now 404 instead of 500. Private report storage volume added to docker-compose.
- Phase 6 part 2 + content: banners, announcements, slots, impressions; CMS pages, FAQs, blog, SEO, media library. Fixed a cross-cutting bug: PATCH bodies built with zod `.partial()` re-applied create defaults (silently resetting fields) — all now use `patchOf()` from `src/core/http/patch-schema.ts`.
- Phase 6 part 1: support tickets, feedback, customer notification centre, staff bell + notification settings, message templates admin, push blasts, segments, campaigns.
