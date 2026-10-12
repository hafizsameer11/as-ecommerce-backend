# Contributing — how code in asl-backend is written

Project: this repo — Express 5 + TypeScript (ESM, alias `@/*` → `src/*`), Prisma 7 (client at `@/generated/prisma/client`), Zod 4, MySQL 8 in Docker (running), Vitest + Supertest e2e tests.
Read README.md and docs/DECISIONS.md first (5 min). Plan: docs/BACKEND_PLAN.md (section 5 describes every module's endpoints).

## Conventions (follow exactly — look at these reference modules)
- Module folder = `x.routes.ts` (declarative ModuleRouter only) → `x.controller.ts` (typed `Ctx<Body,Query,Params>`, HTTP glue, sets `res.locals.audit`, CSV via `sendCsv`) → `x.service.ts` (business logic + Prisma, never req/res) + `x.schemas.ts` (zod + inferred types) + optional `x.mapper.ts`, `x.listeners.ts`.
  References: src/modules/platform/addresses/*, src/modules/commerce/coupons/*, src/modules/commerce/orders/*, src/modules/payments/wallets/*.
- No Prisma import in routes/controller files.
- Money = integer kobo. Admin routes: `defaultAuth: "admin"` + permission from src/core/auth/permissions.ts; mutating admin routes get `audit: {category, action, entity}`.
- Lists return `withMeta(rows, { ...pageMeta(q, total), tabs?, kpis? })` using `pageQuery`, `paging`, `pageMeta` from `@/core/http/pagination`.
- Errors: `ApiError` from `@/core/http/errors` with existing codes (add a code to the ErrorCode union only if really needed).
- Anything that moves money or stock: one `prisma.$transaction`; emit domain events (`@/core/events/bus`) AFTER commit.
- Status wording for the apps comes from src/modules/platform/settings/status-labels.ts.
- Human numbers: `nextSequence(tx, key, start)` + `formatters` from `@/core/utils/sequence` (SHP-, PU-, RET-, DFT-, PO-, JE-).
- Background jobs: `defineJob(name, fn)` in the module + `scheduleRepeating` in src/jobs/schedules.ts. In tests jobs run inline; call the service function directly in tests.
- Emails/SMS/push: `messaging.email(to, templateCode, vars, attachments?)`, `.sms`, `.push` from src/modules/marketing/messaging/messaging.service.ts; template codes in templates.defaults.ts (add templates there if missing). In tests `mail.outbox` (src/providers/mail/mail.ts) holds sent mail.
- Customer has firstName/lastName (no `name`): use `fullName`, `customerBrief` from src/modules/identity/auth/customer.mapper.ts.

## Shared files
When you add a module you usually also touch:
  - src/modules/index.ts — add your imports + router names to `moduleRouters`, and one call inside `registerListeners()`.
  - src/jobs/schedules.ts — add your `scheduleRepeating` line.
  - src/core/events/bus.ts — add event types if needed.
  - src/modules/marketing/messaging/templates.defaults.ts — add templates.
  - Small hooks in other services (e.g. one `events.emit(...)` line) when your task says so.

## Testing
- Write e2e tests per flow, modelled on tests/e2e/commerce.test.ts (resetDb + seedCatalog in beforeAll, helpers in tests/setup/helpers.ts).
- Before committing: `npx tsc --noEmit`, `npm run lint`, `npm test` all clean.


## Schema changes
1. Edit the domain file in `prisma/schema/*.prisma`.
2. Create a migration without touching your data: `mkdir prisma/migrations/<timestamp>_<name>` then
   `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script -o prisma/migrations/<timestamp>_<name>/migration.sql`
   (`prisma migrate dev` also works when you run it yourself in a terminal).
3. `npx prisma migrate deploy && npx prisma generate`.
4. Check nothing is left: the same `migrate diff` command must print "empty migration".

## Running tests
- `npm test` runs every e2e file against `asl_test`. One file: `npx vitest run tests/e2e/<name>.test.ts`.
- A separate test DB: `TEST_DATABASE_URL=mysql://asl:asl@localhost:3306/asl_test_x npx vitest run ...`
- Ledger accounts used by automatic journals: see `prisma/seed/reference.ts` (chart of accounts) and `src/modules/payments/ledger/`.
