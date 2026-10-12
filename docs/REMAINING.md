# What is left — asl-backend

Snapshot when work stopped. All code up to this point is in `D:\projects\asl-orginals\asl-backend` (last commit: "Hardening 1 …").
State: 20 test files / **260 e2e tests passing**, `tsc` and lint clean, migrations in sync with the schema.

Live module status: [`PROGRESS.md`](PROGRESS.md) · business rules + open questions: [`DECISIONS.md`](DECISIONS.md) · how code is written: [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 1. Backend work still to do

Each item is self-contained. Order = suggested priority.

### 1.1 Gateway refunds outside DB transactions (important before going live with Paystack)
- **Problem:** `paymentsService.refund(tx, …)` (`src/modules/payments/payments/payments.service.ts`) calls the gateway inside the caller's DB transaction. If a later step fails, Paystack has refunded but our rows roll back.
- **Fix (outbox):** inside the transaction only create the `Refund` row as queued (`sentAt = null`) and update amounts; after commit a job `payments.send-refunds` (plus a 1-minute sweep in `src/jobs/schedules.ts`) calls `paymentProvider.refund`, stores `providerRef`/status, retries with backoff, and after N failures marks it failed + `notifyStaff('finance_failed')`.
- **Callers to keep working:** order cancel/refund, returns, concierge refunds, late/duplicate payment auto-refunds, drop deposits, card-verification refund, draft orders.
- Run the full suite afterwards.

### 1.2 Ops / production readiness
- Redis-backed rate limits (`src/core/middleware/rate-limit.ts` uses memory; add `rate-limit-redis` when `REDIS_URL` is set).
- S3/R2 storage driver behind `STORAGE_DRIVER=s3` (needed if more than one API server). Report files must stay private (`src/modules/platform/reports/reports.storage.ts`).
- `/ready` endpoint (DB + Redis + storage) and graceful shutdown in `src/server.ts` (close sockets, queue, `prisma.$disconnect`).
- `/metrics` (Prometheus, `prom-client`) protected by a token.
- Database backup script + restore notes; monitoring/alerting; load test.

### 1.3 Smaller features
- **Concierge cart edits** (`src/modules/concierge`): remove item, edit qty/size/colour/notes while new/sourcing (editing after a quote → quote expires, back to sourcing).
- **Shipping labels PDF** (4x6, barcode) `POST /admin/shipments/labels`, `GET /admin/shipments/:id/label.pdf`; carrier webhook `POST /api/v1/webhooks/carriers/:carrier`; shipments CSV export.
- **Draft orders CSV import** `POST /admin/draft-orders/import` + template download.
- Concierge/points/drop journals use generic ledger sources (`order`, `adjustment`) — optionally add `concierge`, `loyalty`, `deposit` to the `JournalSource` enum for cleaner filtering.
- Customer "cookie window" for referrals is only reported, not enforced.

## 2. Business decisions needed (defaults are in place — see DECISIONS.md)

| # | Question | Current default |
|---|---|---|
| D10 | Value of 1 loyalty point | ₦5 |
| D11 | Drop deposit % (UIs say 50 %) | 20 % per drop |
| D4 | Drop balance never paid | Deposit kept |
| D7 | FREESHIP also makes international delivery free | Yes (as admin mock defined) |
| D13 | Sale / clearance / limited items non-returnable? | Not blocked yet |
| D14 | Gift cards | Not built (FAQ seeded as draft) |
| — | Referral reward | ₦15,000 advocate credit / 10 % friend (customer page said ₦5,000) |
| — | Damaged fragrances returnable? | No (never returnable) |
| — | `tr3` brand | Set to ASL ORIGINALS — confirm |
| D5 | Guest checkout | Off |
| D2 | Payment provider | Paystack adapter ready; needs live keys |

## 3. Frontend work (not started — separate from the backend)

None of the three apps calls the API yet; they still use zustand mock stores.
- **asl-web / asl-mobile:** replace each `src/lib/*-store.ts` with API calls (React Query recommended). Start with auth → catalogue → cart/checkout → account. Read `GET /api/v1/store/settings/public` for every business number (delivery fees, return window, tiers, labels) instead of hard-coding.
  - Known hard-coded values to remove: free-shipping ₦50,000 / ₦1,000,000, drop deposit 50 %, APP10 on web, coupon list in checkout.
  - Missing screens the API already supports: return request form, drop reservation page, `/pay/:token` (draft pay link), `/order/:token` (guest order).
- **asl-admin:** same per screen, against `/api/v1/admin/*` (permissions per route in Swagger).
- API reference: run `npm run dev` → http://localhost:4000/docs (or `docs/openapi.json` for client generation).

## 4. How to pick up

```bash
cp .env.example .env
docker compose up -d
npm install && npm run db:generate && npm run db:deploy && npm run db:seed
npm run dev            # API  http://localhost:4000
npm run dev:worker     # background jobs (needs Redis)
npm test               # ~10 min, 260 tests
```

Then take an item from section 1, follow `CONTRIBUTING.md`, and tick it in `PROGRESS.md`.

## 5. Unfinished work saved on a branch

When work was stopped, two helpers had already started on items 1.1, 1.2 and 1.3 (refund outbox, Redis rate limits, S3 driver, /ready + /metrics, backup script, concierge cart edits, shipping labels, draft CSV import).
That code is **not finished or tested**, and it changes the database schema without a migration, so it is kept off `main` on the branch **`wip/hardening-2`** (`git checkout wip/hardening-2` to look at it).
Use it as a starting point, but review it, add a migration (see CONTRIBUTING.md → Schema changes) and run the full test suite before merging.
