# asl-backend

API for ASL ORIGINALS — serves `asl-web`, `asl-mobile` and `asl-admin`.
Express 5 · TypeScript · Prisma 7 · MySQL 8 · Redis (optional in dev).

- Full plan: [`docs/BACKEND_PLAN.md`](docs/BACKEND_PLAN.md)
- Business rules the UIs disagreed on, and how they were settled: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Live API docs (Swagger): http://localhost:4000/docs · raw spec: `/openapi.json`

## Run it locally

Needs Node 22+ and Docker Desktop.

```bash
cp .env.example .env            # Windows: copy .env.example .env
docker compose up -d            # MySQL :3306, Redis :6379, Mailpit :8025, Adminer :8080
npm install
npm run db:generate             # builds the Prisma client into src/generated
npm run db:deploy               # applies migrations
npm run db:seed                 # reference data + catalogue from the prototype + demo accounts
npm run dev                     # http://localhost:4000
npm run dev:worker              # background jobs (only needed when REDIS_URL is set)
```

Seeded accounts:

| Who | Email | Password |
|---|---|---|
| Admin (Super admin) | `admin@asloriginals.com` | `ChangeMe123!` (from `.env`) |
| Customer (Gold tier) | `john.doe@example.com` | `Password123!` |

`npm run db:reset` drops and rebuilds the **local** database (it refuses to touch a non-localhost host).

Emails sent in dev land in Mailpit: http://localhost:8025. Database browser: http://localhost:8080 (server `mysql`, user `asl` / `asl`).

## Tests

```bash
docker compose up -d mysql
npm test
```

Tests run end-to-end against a real MySQL database `asl_test` (created automatically). Redis is not needed: jobs run inline.

## Layout

```
src/
  config/        env validation
  core/          http (router, errors, pagination, openapi), middleware (auth, validate, audit, idempotency),
                 auth (jwt, password, totp, permissions), events, queue, utils
  providers/     swappable integrations: payment (mock), storage (local disk), mail, sms, push
  modules/       one folder per business area — each has  *.routes.ts → *.controller.ts → *.service.ts
                 + *.schemas.ts (zod) + *.mapper.ts (DB row → API shape)
prisma/
  schema/        one .prisma file per domain
  migrations/
  seed/          reference data, catalogue import from the prototype (data/catalog.json + assets/)
tests/e2e/       one file per flow
```

Rules: controllers never touch Prisma; services never touch `req`/`res`; money is stored as integer **kobo**;
anything that moves money or stock runs in one transaction.

## API surfaces

| Prefix | Client | Auth |
|---|---|---|
| `/api/v1/store/*` | asl-web, asl-mobile | Customer JWT. Web uses httpOnly cookies; mobile sends `Authorization: Bearer` and gets tokens in the body |
| `/api/v1/admin/*` | asl-admin | Admin JWT (separate audience) + per-route permission |
| `/api/v1/webhooks/*` | payment providers | signature check |

Errors always look like `{ "error": { "code", "message", "details", "requestId" } }`.
Lists return `{ "data": [...], "meta": { "page", "pageSize", "total", "pageCount" } }`.
Money is always integer **kobo** (₦1 = 100). Actions that create money movements (place order, pay, top up, withdraw) need an `Idempotency-Key` header.

### Buying flow (web and app)

1. `POST /store/cart/items` — guests get a `guestToken`; send it back as `X-Cart-Token`. After sign-in: `POST /store/cart/merge`.
2. `GET /store/checkout` → `PATCH /store/checkout` for each step (contact, address or pick-up store, payment method, wallet) → `POST /store/checkout/coupon`.
3. `POST /store/checkout/place-order` (with `Idempotency-Key`, optional `returnUrl`) → `{ order, payment }`.
4. Open `payment.authorizationUrl` (browser / in-app web view). In dev it is a test page with **Pay** / **Fail** buttons.
5. On return call `POST /store/payments/:reference/verify`, then show `GET /store/me/orders/:id`.

## Build status

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation: config, errors, router, auth middleware, audit, idempotency, queue, providers, Docker, tests | Done |
| 1 | Identity: customer auth (password, OTP, 2FA, sessions), account, admin auth, team + roles/permissions, settings | Done |
| 2 | Catalogue + inventory: products, categories, brands, collections, size guides, reviews, drops, search, home, stock | Done |
| 3 | Cart, wishlist, addresses, coupons, shipping zones, pick-up stores, tax, checkout, orders, payments (mock gateway + webhooks), saved cards, wallet | Done |
| 4 | Shipments + tracking, pick-up bookings, returns/RMA, invoices + packing slips (PDF), draft orders + pay links, abandoned carts + reminders, ledger (auto journals), payouts, admin customers, customer order emails/push | Done |
| 5 | ASL Club (points, tiers, rewards), referrals, drop reservations with deposits, concierge (requests, quotes, payments, chat, suppliers, SLA) | Done |
| 6 | Support tickets, notifications centre, staff alerts, marketing (templates, push blasts, segments, campaigns, banners, slots, announcements), content (CMS, FAQs, blog, SEO, media) | Done |
| 7 | Activity feed, app config, global search, analytics, dashboard, reports | Done |
| 8 | Hardening for launch (real payment provider, websockets, backups, monitoring) — list in docs/PROGRESS.md | Next |

**Where things stand right now, module by module: [`docs/PROGRESS.md`](docs/PROGRESS.md).** How code is written: [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

Background jobs (need `npm run dev:worker` + Redis): unpaid-order expiry (5 min), drop release + reservation expiry (5 min), abandoned-cart scan (15 min), concierge SLA check + quote expiry (15 min), referral qualification (6 h), payouts sync, deleted-account purge, tier recompute, points expiry, birthday bonus (daily).
