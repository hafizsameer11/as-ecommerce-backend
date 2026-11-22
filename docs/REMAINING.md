# What is left — asl-backend

Snapshot when work stopped. All code up to this point is in `D:\projects\asl-orginals\asl-backend` (last commit: "Hardening 1 …").
State: 20 test files / **260 e2e tests passing**, `tsc` and lint clean, migrations in sync with the schema.

Live module status: [`PROGRESS.md`](PROGRESS.md) · business rules + open questions: [`DECISIONS.md`](DECISIONS.md) · how code is written: [`CONTRIBUTING.md`](CONTRIBUTING.md)

---

## 1. Backend work still to do

Each item is self-contained. Order = suggested priority.

### 1.1 Gateway refunds outside DB transactions — **DONE**
Outbox implemented (`queued` → job `payments.send-refunds`). Apply migration `20261123100000_refund_outbox`.

### 1.2 Ops / production readiness
- Redis-backed rate limits — **DONE** (falls back to memory).
- `/ready`, graceful shutdown, `/metrics` (Bearer `METRICS_TOKEN`) — **DONE**.
- **S3/R2 storage — deferred** (local/server uploads for now).
- Database backup script + restore notes — **DONE** (`npm run db:backup`, [`BACKUP.md`](BACKUP.md)); monitoring/alerting; load test — still open.

### 1.3 Smaller features
- **Concierge cart edits** — **DONE** (`PATCH`/`DELETE` `/store/concierge/cart/items/:id`, `POST .../clear`).
- **Shipping labels PDF** / carrier webhooks — deferred (packing slips exist).
- **Draft orders CSV import** — still open.
- JournalSource enum polish; referral cookie window — nice-to-have.

## 2. Business decisions needed (defaults are in place — see DECISIONS.md)

| # | Question | Current default |
|---|---|---|
| D10 | Value of 1 loyalty point | ₦5 |
| D11 | Drop deposit % (UIs say 50 %) | 20 % per drop |
| D4 | Drop balance never paid | Deposit kept |
| D7 | FREESHIP also makes international delivery free | Yes (as admin mock defined) |
| D13 | Sale / clearance / limited items non-returnable? | Not blocked yet |
| D14 | Gift cards | POS + store balance / checkout apply (purchase online still POS-only; FAQ category live) |
| — | Referral reward | ₦15,000 advocate credit / 10 % friend (customer page said ₦5,000) |
| — | Damaged fragrances returnable? | No (never returnable) |
| — | `tr3` brand | Set to ASL ORIGINALS — confirm |
| D5 | Guest checkout | Off |
| D2 | Payment provider | Paystack adapter ready; needs live keys |

## 3. Frontend work

Web, admin, mobile, and POS are largely wired to the API (see `integration-audit/STATUS.md`). Remaining frontend items are polish/deferred (mobile GitHub remote, EAS push build, App Store URLs).

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
