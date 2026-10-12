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
| Marketing | marketing/banners, announcements, slots (+ impressions) | 🟡 next | plan §5.9 |
| Content | content/pages (CMS), faqs, blog, seo, media library API | ⬜ | media upload service exists; plan §5.11 |
| Platform | platform/activity feed, app-config, global-search | ⬜ | plan §5.12 |
| Insights | analytics events + rollups, dashboard, analytics screens, reports | ⬜ | plan §5.12 |
| Hardening | real payment provider, refund/transfer webhooks, websocket chat, S3 storage (if >1 server), backups, monitoring | ⬜ | plan §10, §13 |

## Phase order from here

| Phase | Scope | Status |
|---|---|---|
| 6 | Support (tickets, feedback, notifications centre, staff bell, notification settings) + marketing (templates admin, push blasts, segments, campaigns, banners, announcements, slots) | 🟡 next |
| 7 | Content (CMS pages, FAQs, blog, SEO, media library) + activity feed, app-config, global search | ⬜ |
| 8 | Analytics events + rollups, dashboard, analytics screens, reports | ⬜ |
| 9 | Hardening for launch | ⬜ |
| — | Frontend wiring: replace each zustand mock store in asl-web / asl-mobile / asl-admin with API calls | ⬜ separate work, not started |

## How to continue a module by hand

1. Read its section in `BACKEND_PLAN.md` and the matching UI store in `asl-admin/src/lib/*-store.ts` or `asl-web/src/lib/*-store.ts` (types + actions = what the API must offer).
2. Check the Prisma model already exists in `prisma/schema/` (most do).
3. Copy the shape of a finished module (e.g. `src/modules/commerce/coupons/`): `*.schemas.ts` → `*.service.ts` → `*.controller.ts` → `*.routes.ts`.
4. Register the router in `src/modules/index.ts`, listeners in `registerListeners()`, jobs in `src/jobs/schedules.ts`.
5. Write an e2e test in `tests/e2e/`, run `npx tsc --noEmit && npm run lint && npm test`.
6. Tick the row above and add any rule you decided to `DECISIONS.md`.

## Change log
- Phases 0–5 delivered (identity → concierge), 144 e2e tests.
- Phase 6 part 1: support tickets, feedback, customer notification centre, staff bell + notification settings, message templates admin, push blasts, segments, campaigns.
