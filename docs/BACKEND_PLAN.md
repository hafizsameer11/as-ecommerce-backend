# ASL ORIGINALS — Backend Plan (`asl-backend`)

> **Live status:** see [PROGRESS.md](PROGRESS.md) — which modules are done, what is next, and how to continue by hand.

> Status: **draft for review** — no code has been written yet.
> Stack: **Express 5 + TypeScript + Prisma + MySQL 8**, Docker for local/dev/test.
> Pattern: **module folders, each with routes → controller → service** (+ validation schemas and DTO mappers).

This plan was built by reading the current UI code, not from guesses:

| Client | Folder | Routes read | What it needs from the API |
|---|---|---|---|
| Customer website / PWA | `asl-web` | 94 routes, 52 data stores | Storefront, account, checkout, concierge, support |
| Mobile app (Expo) | `asl-mobile` | Same customer screens as `asl-web` | Same API as the website, plus push-notification tokens |
| Admin panel | `asl-admin` | 58 routes, 66 data stores | Back-office for every module below |

Today every screen runs on **mock data in zustand stores saved in the browser**. Each store's types and actions
(e.g. `useCoupons.create / update / duplicate / setStatus / togglePin`) were used as the source of truth for the
data model and the endpoints in this document. Section 9 maps **every route of all three apps** to the endpoints that serve it.


**Contents:**
0 Decisions · 1 Tech stack · 2 Architecture and folder structure · 3 API conventions · 4 Identity and permissions ·
5 Modules and endpoints (5.1 Catalog, 5.2 Inventory, 5.3 Commerce, 5.4 Fulfilment, 5.5 Payments, 5.6 Loyalty, 5.7 Concierge, 5.8 Support, 5.9 Marketing, 5.10 Customers, 5.11 Content, 5.12 Platform) ·
6 Data model · 7 Key flows · 8 Jobs and events · 9 Screen coverage (every route) · 10 Docker · 11 Testing · 12 Delivery phases · 13 Issues, decisions, risks

---

## 0. Decisions already made

| Topic | Decision | Consequence |
|---|---|---|
| Language / framework | Express + TypeScript | Express 5 (native async error handling) |
| ORM / DB | Prisma + MySQL 8 | Money stored as integer **kobo**; flexible bits (page blocks, rules) as `Json` columns |
| Payments | **Decide later → mock adapter** | A `PaymentProvider` interface with a `MockProvider` now; Paystack/Flutterwave become a new file later, no module changes |
| File storage | **Local disk** | A `StorageDriver` interface with a `LocalDiskDriver` (Docker volume). See risk R3 — swap to S3/R2 before running more than one server |
| Code layout | Module folders, service + controller | Section 2 |
| Scope of this step | Plan only | You review this, then we build phase by phase (section 12) |

---

## 1. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS | Current LTS |
| HTTP | Express 5 | Requested; async errors reach the error middleware without wrappers |
| Language | TypeScript (strict) | |
| ORM | Prisma 6 | Requested; migrations + typed client |
| DB | MySQL 8.0 (InnoDB, `utf8mb4`) | Requested |
| Validation | **Zod** | One schema validates the request **and** generates OpenAPI docs |
| API docs | `@asteasolutions/zod-to-openapi` + Swagger UI at `/docs` | Frontend devs (and the 3 apps) code against it |
| Auth | JWT access token (15 min) + rotating refresh token (30 days, hashed in DB) | Web/admin: httpOnly cookies. Mobile: `Authorization: Bearer` + refresh in secure storage |
| Passwords | `argon2` | |
| 2FA | TOTP (`otplib`) | Security screen + admin team `twoFactor` |
| Jobs / scheduling | **BullMQ + Redis** | Emails, campaign sends, report runs, drop releases, SLA timers, abandoned-cart reminders, scheduled publishing. *Redis is the one service not in your list — see R1* |
| Realtime | Socket.IO (Redis adapter) | Concierge chat, ticket replies, admin live activity feed |
| Uploads | `multer` + `sharp` (resize/thumbnails/WebP) | Media library, product images, review photos, concierge reference images |
| Email | Nodemailer (SMTP) behind a `MailProvider` interface; **Mailpit** in Docker | Resend/SendGrid/SES (all listed in admin settings) become adapters later |
| SMS / WhatsApp / Push | `SmsProvider` (mock → Twilio / Africa's Talking), `PushProvider` (Expo Push for the mobile app, Web Push for PWA) | Matches the admin notification-channel settings |
| Logging | `pino` + `pino-http` (request id) | |
| Security | `helmet`, `cors` (allow-list per app), `express-rate-limit` (Redis store), `hpp` | |
| Exports | `exceljs` (xlsx), `csv-stringify`, `pdfkit` (invoices, packing slips, PDF reports) | Admin "Export", "Print slips", "Email invoice", reports |
| Tests | Vitest + Supertest against a real MySQL in Docker | Section 11 |
| Lint/format | ESLint + Prettier, Husky pre-commit | |

---

## 2. Architecture and folder structure

### 2.1 One API, two surfaces

One Express app serves all three clients, split by URL prefix and by who is allowed in:

| Prefix | Used by | Auth |
|---|---|---|
| `/api/v1/store/*` | `asl-web`, `asl-mobile` | Public, or customer JWT (`requireCustomer`) |
| `/api/v1/admin/*` | `asl-admin` | Admin JWT + permission check (`requirePermission("orders.refund")`) |
| `/api/v1/webhooks/*` | Payment / SMS / email providers | Provider signature verification |
| `/uploads/*` | Everyone | Static files from the local-disk storage driver |
| `/docs`, `/health` | Developers, Docker health check | — |

Customers and admin staff are **separate tables and separate token audiences**, so a customer token can never reach an admin route.

### 2.2 Folder layout

```
asl-backend/
├─ docker/                     # Dockerfiles, mysql init, nginx (later)
├─ docker-compose.yml          # api, mysql, mysql-test, redis, mailpit, adminer
├─ prisma/
│  ├─ schema/                  # Prisma multi-file schema, one file per domain
│  │  ├─ _base.prisma          #   generator + datasource
│  │  ├─ identity.prisma  catalog.prisma  commerce.prisma  ...
│  ├─ migrations/
│  └─ seed/                    # seed scripts, ported from the UI mock data
│     ├─ index.ts
│     └─ data/ products.ts brands.ts categories.ts ...
├─ src/
│  ├─ app.ts                   # builds the express app (no listen) → used by tests
│  ├─ server.ts                # listen + graceful shutdown
│  ├─ worker.ts                # BullMQ workers (separate process)
│  ├─ config/                  # env.ts (zod-validated env), constants.ts
│  ├─ core/
│  │  ├─ db/prisma.ts          # PrismaClient singleton + soft-delete/audit extensions
│  │  ├─ http/                 # ApiError, response helpers, pagination, asyncHandler
│  │  ├─ middleware/           # auth, permissions, validate, rateLimit, idempotency, audit, errorHandler, requestId
│  │  ├─ auth/                 # jwt, password, totp, otp helpers
│  │  ├─ events/               # typed in-process event bus (order.placed → points, email, ledger…)
│  │  ├─ queue/                # BullMQ queues + job names
│  │  ├─ realtime/             # socket.io server, rooms, auth handshake
│  │  ├─ money.ts  ids.ts  dates.ts  slug.ts  csv.ts
│  ├─ providers/               # swappable integrations, each = interface + implementations
│  │  ├─ payment/  PaymentProvider.ts  mock.provider.ts  (paystack.provider.ts later)
│  │  ├─ storage/  StorageDriver.ts  local-disk.driver.ts  (s3.driver.ts later)
│  │  ├─ mail/     MailProvider.ts  smtp.provider.ts
│  │  ├─ sms/      SmsProvider.ts  mock.provider.ts
│  │  ├─ push/     PushProvider.ts  expo.provider.ts  webpush.provider.ts
│  │  └─ fx/       FxProvider.ts  static.provider.ts
│  ├─ modules/                 # ← all business logic lives here (section 5)
│  │  ├─ identity/
│  │  │  ├─ auth/   customers/   admin-auth/   team/
│  │  ├─ catalog/
│  │  │  ├─ products/  categories/  brands/  collections/  size-guides/  reviews/  drops/  search/
│  │  ├─ inventory/
│  │  ├─ commerce/
│  │  │  ├─ carts/  wishlist/  checkout/  orders/  draft-orders/  returns/  coupons/
│  │  ├─ fulfilment/
│  │  │  ├─ shipping-zones/  shipments/  pickups/  tax/
│  │  ├─ payments/
│  │  │  ├─ payments/  payment-methods/  wallets/  payouts/  ledger/
│  │  ├─ loyalty/
│  │  │  ├─ club/  referrals/
│  │  ├─ concierge/
│  │  │  ├─ requests/  quotes/  chat/  suppliers/  concierge-catalog/
│  │  ├─ support/
│  │  │  ├─ tickets/  feedback/  notifications/
│  │  ├─ marketing/
│  │  │  ├─ segments/  campaigns/  messaging/  banners/  announcements/  slots/
│  │  ├─ content/
│  │  │  ├─ pages/  faqs/  blog/  seo/  media/
│  │  ├─ platform/
│  │  │  ├─ settings/  notification-settings/  audit/  activity/  reports/  analytics/
│  │  │  dashboard/  addresses/  app-config/  global-search/
│  │  └─ index.ts             # registers every module router
│  └─ types/express.d.ts       # req.customer, req.admin, req.id
├─ tests/
│  ├─ setup/  (test db reset, factories)
│  └─ e2e/    (one file per flow: checkout, returns, concierge, wallet …)
├─ .env.example
└─ package.json
```

### 2.3 Inside one module

Every module looks the same, so anyone can open any folder and know where things are. Example `modules/commerce/coupons/`:

```
coupons/
├─ coupons.store.routes.ts     # /store/coupons/*  → customer endpoints
├─ coupons.admin.routes.ts     # /admin/coupons/*  → admin endpoints (+ permission per route)
├─ coupons.controller.ts       # HTTP only: read req, call service, shape response. No Prisma here.
├─ coupons.service.ts          # Business rules + Prisma + transactions + events. No req/res here.
├─ coupons.schemas.ts          # Zod: body/query/params for each endpoint (also feeds OpenAPI)
├─ coupons.mapper.ts           # DB row → API DTO (hides internal fields, kobo → number formatting rules)
├─ coupons.events.ts           # events this module emits/listens to (optional)
├─ coupons.jobs.ts             # BullMQ processors (optional)
└─ __tests__/coupons.service.test.ts  coupons.api.test.ts
```

Rules that keep it manageable:

1. **Controllers never touch Prisma; services never touch `req`/`res`.**
2. **Modules talk to each other through services or events, never through each other's tables.**
   E.g. `orders.service` calls `inventoryService.reserve()` and `couponsService.redeem()`; it does not run `prisma.stockLevel.update`.
3. Anything that changes **money or stock** runs inside one `prisma.$transaction` and writes a ledger/movement row.
4. Side effects (emails, points, push, analytics) go through the **event bus → queue**, so a slow email never fails an order.
5. Each module exports only `xxxService` and its routers from `index.ts`.
6. A route file declares **validation + auth + permission + audit** on one line each:

```ts
router.post(
  "/:id/refund",
  requireAdmin,
  requirePermission("orders.refund"),
  validate(refundOrderSchema),
  audit("orders", "order.refunded"),
  ordersController.refund,
);
```

---

## 3. API conventions (all modules follow these)

| Topic | Rule |
|---|---|
| Versioning | `/api/v1/...`; breaking changes → `/v2` |
| Style | REST resources; state changes that aren't plain edits are **action sub-routes**: `POST /admin/orders/:id/refund`, `POST /admin/coupons/:id/duplicate`, `PATCH /admin/coupons/:id/status` |
| Bulk actions | `POST /admin/<resource>/bulk` with `{ ids, action, payload }` — the admin tables all have multi-select (orders, reviews, media, products, shipments…) |
| Success response | `{ data, meta? }` — `meta` holds pagination / totals |
| Error response | `{ error: { code: "COUPON_EXPIRED", message, details?, requestId } }` + proper HTTP status. Codes are stable strings the apps can map to the UI's toast messages |
| Pagination | `?page=1&pageSize=25` (admin tables) **and** cursor `?cursor=…&limit=20` (infinite scroll on shop / chat / notifications) |
| Filtering / sort / search | `?status=active&brand=nike&q=hoodie&sort=-createdAt` — every admin table has tabs, search and sort, so every list endpoint supports them |
| Money | Stored as **integer kobo** (`Int`, or `BigInt` for ledger totals). API returns `{ amount: 2850000, currency: "NGN" }` in kobo; apps format. *The UI stores naira today — the API layer converts* |
| IDs | Internal `cuid2` primary keys **plus** human references the UI already shows: `ASL-ORD-10248`, `RET-2210`, `DFT-3421`, `ASL123456` (concierge), `#5201` (tickets), `TCMV1CB44W`-style references |
| Dates | ISO-8601 UTC in the API; DB `DATETIME(3)`; the store timezone (`Africa/Lagos`) lives in settings |
| Idempotency | `Idempotency-Key` header **required** on: place order, pay, wallet top-up/withdraw, refund, payout actions. Stored 24h in Redis |
| Soft delete | `deletedAt` on customer-facing content and customers (orders and ledger rows are never deleted — cancelled/voided instead) |
| Audit | Every admin write records an `AuditEvent` (actor, role, IP, device, before/after diff) via the `audit()` middleware — powers **/audit** |
| Concurrency | `updatedAt` optimistic check (`If-Unmodified-Since` / `version` field) on CMS-style editors (pages, blog, products) so two admins don't overwrite each other |
| Localization | `Accept-Language` + `X-Currency` headers; prices converted with settings FX rates for display only — **orders always settle in NGN** |
| Rate limits | Auth 5/min/IP, OTP 3/10 min, public lists 120/min, admin 600/min |
| Uploads | `multipart/form-data` to `POST /…/uploads`, returns a `MediaAsset`; other endpoints reference assets by id |
| Realtime | Socket.IO namespaces `/store` and `/admin`; rooms `customer:{id}`, `thread:{id}`, `ticket:{id}`, `admin:activity` |

### 3.1 Standard error codes (examples)

`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`,
`OUT_OF_STOCK`, `COUPON_INVALID`, `COUPON_EXPIRED`, `COUPON_MIN_SUBTOTAL`, `INSUFFICIENT_POINTS`,
`INSUFFICIENT_WALLET_BALANCE`, `WALLET_FROZEN`, `RETURN_WINDOW_CLOSED`, `DROP_NOT_OPEN`, `ALREADY_RESERVED`,
`QUOTE_EXPIRED`, `PAYMENT_FAILED`, `OTP_INVALID`, `TWO_FACTOR_REQUIRED`, `MAINTENANCE_MODE`.

---

## 4. Identity, authentication and permissions

### 4.1 Customers (`asl-web`, `asl-mobile`)

Screens: `/auth` (sign in, sign up, forgot, OTP), login modal, onboarding, `/account/security`, `/account/settings`.

| Endpoint | Purpose |
|---|---|
| `POST /store/auth/register` | name, email, phone?, password → account + session; awards **signup bonus points** (club rules) and links a **referral code** if present |
| `POST /store/auth/login` | email + password → tokens; returns `TWO_FACTOR_REQUIRED` + challenge id if 2FA on |
| `POST /store/auth/login/2fa` | challenge id + TOTP code |
| `POST /store/auth/otp/request` / `verify` | passwordless / phone verification (the UI's `otp` mode) |
| `POST /store/auth/password/forgot` / `reset` | email link with single-use token (30 min) |
| `POST /store/auth/refresh` | rotate refresh token (reuse detection → revoke family) |
| `POST /store/auth/logout` | revoke current session |
| `GET /store/me` · `PATCH /store/me` | profile: first/last name, phone + country code, DOB, gender, avatar (`/account/details`) |
| `POST /store/me/avatar` | upload avatar ("Change photo") |
| `POST /store/me/password` | change password (`/account/security`) |
| `POST /store/me/2fa/setup` · `enable` · `disable` | TOTP QR + recovery codes |
| `GET /store/me/sessions` · `DELETE /store/me/sessions/:id` · `DELETE /store/me/sessions?others=true` | "Active sessions", "Revoke", "Sign out all other sessions" |
| `PATCH /store/me/preferences` | language, currency, privacy toggles (analytics / personalization / marketing cookies), marketing opt-in |
| `POST /store/me/onboarding/complete` | `hasOnboarded` (synced across web + app) |
| `DELETE /store/me` | "Delete account" → `DELETE` confirmation; soft-delete + anonymise PII after 30 days (job), keep orders for accounting |
| `POST /store/me/push-tokens` · `DELETE …/:token` | Expo push token (mobile) / Web Push subscription (PWA) |

**Guest checkout:** the admin setting `checkout.guestCheckout` exists, but today the UI forces a login before checkout. The API supports
both — guest orders get a `guestEmail` and a signed order-lookup token (also used by `/customer-care/track-order`).

### 4.2 Admin staff (`asl-admin`)

Screens: `/login`, `/team`, top bar (role switcher in the prototype), `/settings`.

| Endpoint | Purpose |
|---|---|
| `POST /admin/auth/login` (+ `/2fa`) · `refresh` · `logout` | separate JWT audience `admin` |
| `GET /admin/me` · `PATCH /admin/me/preferences` | name, **density**, **sidebarCollapsed** (stored server-side so they follow the user) |
| `POST /admin/auth/invite/accept` | set password from invite link |
| `GET/POST /admin/team/members` · `PATCH/DELETE …/:id` | invite (name, email, role), suspend/reactivate, change role, remove |
| `POST /admin/team/members/:id/resend-invite` | "Invite resent" |
| `GET /admin/team/roles` · `PUT /admin/team/roles/:role/permissions` · `DELETE …/permissions` | role permission overrides / "Reset to default" |

**Roles** (from `admin-role-store`): `super_admin, ops_manager, catalog_manager, concierge_agent, support, marketing, finance, content_editor, analyst`.
**Permissions** (from `team-store`, used as-is by `requirePermission`):
`orders.view|edit|refund · concierge.view|assign|quote · catalog.view|edit|publish · inventory.adjust · customers.view|edit|wallet ·
marketing.manage · content.publish · finance.view|payouts|ledger · analytics.view · support.tickets|reply · team.manage ·
settings.manage · integrations.manage · audit.view`.
Effective permissions = role defaults ∪ role overrides (DB). Sidebar items are filtered with the same list (`GET /admin/me` returns the permission set).

> The prototype lets anyone **switch roles from the top bar**. In production that becomes "view as role" for `super_admin` only.

---

## 5. Modules and endpoints

Legend: **S** = `/api/v1/store` (customer), **A** = `/api/v1/admin` (permission in brackets). `:id` accepts the internal id or the human reference.

### 5.1 Catalog

#### `catalog/products`
Models: `Product`, `ProductImage`, `ProductVariant` (size × colour → **SKU**), `ProductColor`, `ProductSizeLabel` (designer size labels like `S (46)`), `ProductFeature`, `ProductTag`.
Fields from UI: brand, name, price, originalPrice (sale), category/subcategory, sizes, colours (+hex), availability (`In Stock | Pre Order | Limited Pieces | Restocked`), isConcierge, description, features, styleCode, gallery, sizeLabels, modelFit, status (`Active | Draft | Archived`), rating aggregate.

| | Endpoint | Screen |
|---|---|---|
| S | `GET /products` — filters: category, subcategory, brand[], size[], colour[], price range, availability, onSale, isConcierge, collection; sort: featured, newest, price asc/desc, best-selling, trending | shop, category, browse, sales, trending, best sellers, new arrivals, brand, collection |
| S | `GET /products/facets?…` | filter sheets (counts per brand/size/colour/price) |
| S | `GET /products/:id` | product page, quick view, quick add |
| S | `GET /products/:id/related` · `/also-like` | "You may also like" (product, wishlist) |
| S | `GET /home` (composite) | home: hero slots, categories, best sellers, trending, promo, concierge banner — one call for fast first paint |
| A | `GET /products` (+ stock state, rating, sort name/price/stock/rating/brand) · `POST` · `GET/PATCH/DELETE /:id` [catalog.view / catalog.edit] | /products |
| A | `POST /products/:id/duplicate` · `PATCH /:id/status` (archive/publish) [catalog.publish] | row actions |
| A | `POST /products/bulk` `{ action: archive | delete | setCategory | publish }` | multi-select bar |
| A | `PUT /products/:id/variants` · `PUT /products/:id/images` (order + alt) · `PUT /products/:id/sizing` (size labels, model fit, "Use designer sizes") | product editor, inventory sizing |
| A | `POST /products/import` (CSV) · `GET /products/export` | |

#### `catalog/categories`
Models: `Category` (name, handle, description, status `active|hidden|draft`, featured, order, image, icon, SEO), `Subcategory`.
S: `GET /categories` (tree, active only) · `GET /categories/:handle`.
A [catalog.edit]: CRUD · `PATCH /:id/status` · `POST /:id/feature` · `POST /:id/move {dir}` · `POST /:id/subcategories` · `PATCH/DELETE /:id/subcategories/:subId`.

#### `catalog/brands`
Model: `Brand` (name, handle, tagline, description, country, tier `signature|core|emerging`, status, featured, logo, accent, website, conciergeOnly, SEO).
S: `GET /brands` (A–Z directory, search, filter, item counts) · `GET /brands/:handle` (+ products) · `GET /concierge/brands`.
A [catalog.edit]: CRUD · `duplicate` · `PATCH status | tier` · `POST feature` · `POST concierge-only`.

#### `catalog/collections`
Model: `Collection` (title, handle, description, status `active|scheduled|draft|archived`, type `manual|smart`, slot `hero|home_row_1|home_row_2|shop_hub|none`, productIds (join table for manual), rules `Json` for smart, cover, featured, publish/schedule dates, tags, sortOrder).
Smart collections are resolved by a rule → Prisma `where` builder (field `category|brand|price|availability|subcategory`, op `is|is_not|gt|lt|contains`).
S: `GET /collections/:handle` (+ products, sorted).
A [catalog.edit]: CRUD · `duplicate` · `PATCH status | slot` · `POST feature` · `GET /:id/preview` (products the rules match).

#### `catalog/size-guides`
Model: `SizeGuide` (scope `brand|category`, target, note, chartUrl).
S: `GET /size-guides?brand=&category=` (product page "Size guide"). A [catalog.edit]: CRUD (`/size-guides` screen).

#### `catalog/reviews`
Models: `Review` (product, customer, rating 1–5, title, body, size, fit `Runs small|True to size|Runs large`, verified purchase, photos, status `pending|published|rejected|flagged`, reportedCount, helpful), `ReviewReply`, `ReviewVote`, `ReviewReport`.
| | Endpoint |
|---|---|
| S | `GET /products/:id/reviews` (rating summary, fit summary, sort, filter by stars, paginated) |
| S | `POST /products/:id/reviews` (write review sheet; verified flag if the customer bought it) — awards **review bonus points** once published |
| S | `POST /reviews/:id/helpful` · `POST /reviews/:id/report` |
| A | `GET /reviews` · `PATCH /:id/status` · `POST /bulk {publish|reject|flag|delete}` · `POST /:id/reply` · `DELETE /:id` [catalog.edit] |

#### `catalog/drops` (Coming soon / reservations)
Models: `Drop` (product, releaseAt, allocation, teaser, depositPct, status `upcoming|live|sold_out|ended`), `Reservation` (customer, size, price, deposit, balance, status `reserved|balance_paid|cancelled|expired|converted`), `BackInStockAlert`.
| | Endpoint | Screen |
|---|---|---|
| S | `GET /drops` · `GET /drops/:id` (countdown, reserved count / allocation) | /coming-soon, /drop/:id |
| S | `POST /drops/:id/reserve {size}` → payment intent for the **deposit** | Reserve block |
| S | `GET /me/reservations` · `POST /me/reservations/:id/cancel` | account orders → reservation panel |
| S | `POST /orders/:id/pay-balance` → payment intent for the balance | "Pay balance" on reservation timeline |
| S | `POST /products/:id/notify-me {size?}` · `DELETE` | "Notify me" (back in stock) |
| A | Drops are managed inside **products** (`PUT /products/:id/drop`); reservations listed under orders. *There is no dedicated admin drops screen yet — see issue U7* |
Jobs: `drop.release` at `releaseAt` (open checkout, notify reservers), `reservation.expire` if balance unpaid N days after release.

#### `catalog/search`
S: `GET /search?q=` (products, brands, categories — typo-tolerant using MySQL FULLTEXT + trigram fallback), `GET /search/suggest?q=` (type-ahead), `GET /search/popular` ("Popular searches", "Trending now").
Recent searches stay **on the device** (privacy, already works offline); optional `POST /me/recent-searches` sync later.
Search queries are logged (`SearchLog`) to feed **analytics/traffic** and "popular searches".

### 5.2 Inventory — `inventory`
Models: `Warehouse` (name, code, city), `StockLevel` (sku × warehouse: onHand, reserved, reorderPoint, cost), `StockMovement` (`receive|adjust|transfer|sale|return|reservation|release`, qty, note, user, ts).
Rules: available = onHand − reserved; order placement **reserves** stock inside the order transaction (row lock `SELECT … FOR UPDATE`); payment success converts to `sale`; cancel/expire releases; approved return → `return`.
A [inventory.adjust]: `GET /inventory` (stock state `In stock|Low stock|Out of stock|Backorder`, per warehouse) · `POST /inventory/adjust` · `POST /inventory/transfer` · `PATCH /inventory/:sku/:warehouseId/reorder-point` · `GET /inventory/movements` · `GET/POST/PATCH /warehouses`.
Event `stock.low` → admin activity feed + notification rule `catalog_low_stock` / `catalog_oos`.

### 5.3 Commerce

#### `commerce/carts`
Models: `Cart` (customerId? / guestToken, currency, status `active|converted|abandoned|recovered|lost`, lastActivityAt, email captured, channel `web|mobile|pwa`), `CartItem` (variant/sku, qty, unit price snapshot).
| | Endpoint | Screen |
|---|---|---|
| S | `GET /cart` · `POST /cart/items {productId, size, colour, qty}` · `PATCH /cart/items/:id {qty, size}` · `DELETE /cart/items/:id` · `DELETE /cart` | cart, quick-add, product "Add to bag", cart size picker |
| S | `POST /cart/remove-unavailable` | "Sold out items removed from your cart" |
| S | `POST /cart/merge` | on login: guest cart merged into account cart |
| S | `GET /cart/summary` | header bag badge count |
| A | `GET /carts/abandoned` (stage `Just abandoned → Reminder 1 sent → Reminder 2 sent → Recovered → Lost`) [marketing.manage] | /carts |
| A | `POST /carts/:id/remind {channel}` · `POST /carts/remind-bulk` · `GET/PUT /carts/recovery-rules` | "Send reminder", "Bulk reminder", "Recovery rules saved" |
Job: `cart.abandon-scan` every 15 min using `settings.checkout.abandonMinutes`; reminders via messaging templates; recovery link restores the cart.

#### `commerce/wishlist`
Model: `WishlistItem` (customer, product, size?, colour?).
S: `GET /wishlist` (+ "On sale" count) · `POST /wishlist {productId, size?, colour?}` (toggle) · `DELETE /wishlist/:productId` · `POST /wishlist/merge` (guest → account).
Event: price drop / back in stock on a wishlisted product → notification (`Wishlist` category, "Price Drop Alert", "Back in Stock").

#### `commerce/coupons`
Models: `Coupon` (code, title, type `percent|fixed|free_shipping|bogo`, value, status, starts/ends, minSubtotal, maxDiscount, usageLimit, perCustomerLimit, appliesTo `all|categories|brands|products|collections` + refs, eligibility `all|new|vip|segment` + segmentId, stackable, autoApply, oncePerCustomer, channels, pinned, notes), `CouponRedemption`, `CustomerCoupon` (coupons **minted for one customer** by rewards / referrals / promos — today's `my-coupons-store`).
| | Endpoint |
|---|---|
| S | `POST /checkout/coupon {code}` → validates against cart; `DELETE /checkout/coupon` (lives in checkout, logic here) |
| S | `GET /me/coupons` ("Your coupons" chips on payment step) |
| A | `GET/POST /coupons` · `GET/PATCH/DELETE /:id` · `POST /:id/duplicate` · `PATCH /:id/status` · `POST /:id/pin` · `GET /:id/redemptions` [marketing.manage] |
Rules engine checks, in order: status/dates → channel → eligibility/segment → per-customer & global limits → minSubtotal → appliesTo → stacking → computes discount (capped by maxDiscount). Auto-apply picks the best when `settings.checkout.autoApplyBestCoupon`.

#### `commerce/checkout`
Stateless calculator + a saved `CheckoutSession` (per cart) so web and app resume the same step.
| | Endpoint | Screen |
|---|---|---|
| S | `GET /checkout` | restores contact, address, delivery, payment choice, coupon |
| S | `PUT /checkout/contact {email, phone, subscribe}` | Information step |
| S | `PUT /checkout/delivery {method: ship|pickup, address | pickupLocationId}` | Information step (ship / pick-up in store) |
| S | `GET /checkout/shipping-options` | delivery fee card (zone rates) |
| S | `PUT /checkout/payment {method: card|bank|paystack|wallet}` | Payment step |
| S | `GET /checkout/totals` | Order summary everywhere: subtotal, discount, shipping, tax, total, wallet applied |
| S | `POST /checkout/place-order` (Idempotency-Key) → `{ order, paymentIntent }` | Review → Place order |
Totals are **always recomputed on the server** at place-order (price, stock, coupon, shipping, tax) — the client total is only a preview.

#### `commerce/orders`
Models: `Order` (number `ASL-ORD-xxxxx`, customer/guest, channel, status, paymentStatus, fulfilmentStatus, subtotal, discount, couponCode, shipping, tax, total, walletApplied, delivery method, contact + address snapshot, pickup location, placedAt, notes), `OrderItem` (product/variant snapshot: name, brand, image, size, colour, qty, unit price), `OrderEvent` (timeline: placed, payment confirmed, preparing, shipped, out for delivery, delivered, cancelled, refunded…), `OrderNote` (internal).
Status model (one place, mapped to both UIs):
`pending_payment → paid → processing → shipped → out_for_delivery → delivered`, side exits `cancelled`, `returned`, `refunded` / `partially_refunded`.
Customer labels (`Processing | Shipped | Delivered | Cancelled | Returned`) and admin labels (Awaiting payment, Unfulfilled, Open…) are **mappers**, not separate data.
| | Endpoint | Screen |
|---|---|---|
| S | `GET /me/orders?status=` · `GET /me/orders/:id` | account orders, order detail, recent order card |
| S | `GET /me/orders/:id/tracking` | /account/track, order progress timeline |
| S | `GET /me/orders/:id/invoice.pdf` | "Invoice downloading…" |
| S | `POST /me/orders/:id/cancel` (only before shipping) | |
| S | `POST /me/orders/:id/reorder` | adds items back to cart |
| S | `POST /orders/lookup {orderNumber, email}` (guest, rate-limited) | /customer-care/track-order, track box on /account/track |
| A | `GET /orders` (tabs: open, unfulfilled, awaiting payment; search; KPIs) · `GET /:id` [orders.view] | /orders, /orders/:id |
| A | `PATCH /:id/status` · `POST /bulk {status | cancel | print-slips}` [orders.edit] | bulk bar, "Print slips" (PDF) |
| A | `POST /:id/fulfil` (creates shipment or pickup booking) · `POST /:id/notes` · `POST /:id/email-invoice` · `GET /:id/invoice.pdf` · `GET /:id/packing-slip.pdf` | order detail buttons |
| A | `POST /:id/refund {amount?, items?, reason, to: original|wallet}` [orders.refund] | "Refund order" |
| A | `GET /orders/export` | |
Side effects of `order.paid` (via events → queue): confirmation email/SMS/push, points earned (club rules × tier multiplier), referral qualification check, coupon redemption recorded, ledger journal, admin activity + notification rule `order_new` / `order_high_value` (> ₦2M).

#### `commerce/draft-orders`
Model: `DraftOrder` (number `DFT-xxxx`, customer, items, totals, status `draft|sent|converted`, note).
A [orders.edit]: CRUD · `POST /:id/duplicate` · `POST /:id/send` (emails a pay-link) · `POST /draft-orders/import` (CSV) · `POST /:id/convert` (customer paid → real order).
S: `GET /pay/:token` → shows the draft and creates a payment intent (customer pays the link).

#### `commerce/returns`
Models: `ReturnRequest` (number `RET-xxxx`, order, customer, items + qty, reason, details, photos, status `requested|approved|in_transit_back|received|under_investigation|refunded|rejected`, refund amount, refund method, inspector notes), `ReturnEvent`.
| | Endpoint | Screen |
|---|---|---|
| S | `GET /me/returns` · `GET /me/returns/:id` | /account/returns, status timeline |
| S | `GET /me/orders/:id/returnable` (items still inside the return window) | "Start a return request" |
| S | `POST /me/returns {orderId, items, reason, details, photos}` | /account/returns/details |
| S | `GET /content/pages/return-policy` | /account/returns/policy, how-it-works (CMS) |
| A | `GET /returns` · `POST /returns` (Create RMA) · `POST /:id/approve | reject | mark-received | investigate | refund` [orders.refund] | /returns |
Rules: return window from settings (see issue U3), non-returnable categories, refund → payments module (original method or wallet), stock movement `return` on receipt.

### 5.4 Fulfilment

#### `fulfilment/shipping-zones`
Models: `ShippingZone` (name, scope `country|state|city|postcode`, countries[], regions[], priority, active, notes), `ZoneRate` (name, carrier `DHL|FedEx|UPS|GIG|Aramex|Local|In-house`, service, baseFee, perKgFee, min/max kg, etaDays, freeAbove, active).
S: used internally by `checkout/shipping-options`; `GET /shipping/estimate?state=&country=` for the product page / cart delivery hint.
A [settings.manage]: zones CRUD · `POST /:id/duplicate` · `POST /:id/toggle` · `PUT /:id/rates/:rateId` · `DELETE /:id/rates/:rateId` · stats (`ordersLast30`, `revenueLast30` computed).

#### `fulfilment/shipments`
Models: `Shipment` (order, carrier, service, tracking no., status `label_created|picked_up|in_transit|out_for_delivery|delivered|exception|returned`, origin warehouse, destination, weight, items, declared value, cost, insured, signature required, eta, timestamps), `ShipmentEvent` (status, location, note, at).
S: `GET /me/orders/:id/tracking` returns shipment events (copy tracking number, timeline).
A [orders.edit]: `GET /shipments` (tabs) · `POST /shipments` · `PATCH /:id` · `POST /:id/advance {status, location, note}` · `POST /bulk/labels` (PDF labels) · `DELETE /:id` · export.
Carrier integration = `CarrierProvider` interface (manual/mock now; DHL/GIG APIs later) + `POST /webhooks/carriers/:carrier`.

#### `fulfilment/pickups`
Models: `PickupLocation` (name, address, city, state, country, phone, hours, active, concierge, capacityPerDay), `PickupBooking` (order, customer, location, scheduledAt, status `scheduled|ready|collected|no_show|cancelled`, items, notes, collectedAt, collectedBy).
S: `GET /pickup-locations` (checkout "Pick up in store" card with address + hours) · slot availability by capacity.
A [orders.edit]: locations CRUD + toggle · bookings list (dashboard "Today's pickups", "Ready to collect") · `POST /bookings/:id/advance {status, collectedBy}` · `POST /bookings/:id/notes`.
Event `pickup.ready` → SMS/push "Your order is ready for pick-up".

#### `fulfilment/tax`
Models: `TaxRate` (name, scope, region, rate, basis `inclusive|exclusive`, appliesTo `products|shipping|concierge_fee`, code, active), `TaxCategory` (+ regional overrides), `TaxExemption` (customer|order, reference, reason, certificate, validUntil), `TaxSettings` (display inc. tax, tax shipping, tax concierge, TIN, legal name, invoice prefix, fiscal year start, rounding `line|subtotal`).
Used by checkout totals and invoices. A [settings.manage]: rates CRUD + toggle · categories update · exemptions add/remove · settings update · `GET /tax/report?from=&to=` (VAT collected).

### 5.5 Payments and money

#### `payments/payments` (provider adapter)
```ts
interface PaymentProvider {
  createIntent(input: { amount: number; currency: "NGN"; email: string; reference: string;
                        purpose: "order"|"order_balance"|"reservation_deposit"|"wallet_topup"|"concierge"|"draft_order";
                        method: "card"|"bank_transfer"|"ussd"|"saved_card"; savedMethodId?: string; metadata: object }): Promise<{ redirectUrl?: string; accessCode?: string; reference: string }>;
  verify(reference: string): Promise<{ status: "success"|"failed"|"pending"; amount: number; fee: number; raw: unknown }>;
  refund(reference: string, amount: number): Promise<{ status: "pending"|"processed"; refundRef: string }>;
  transfer(input: { amount: number; bankCode: string; accountNumber: string; reason: string }): Promise<{ transferRef: string; status: string }>; // wallet withdrawals
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
  listBanks(): Promise<{ code: string; name: string }[]>;
  parseWebhook(headers, rawBody): WebhookEvent; // signature check
}
```
`MockProvider` behaves like Paystack (redirect to a local "mock checkout" page with Pay / Fail buttons, then fires the webhook) so the apps can be built end-to-end now.
Models: `Payment` (reference, purpose, owner ids, amount, fee, status, method, provider, raw), `Refund`, `WebhookLog` (dedupe by provider event id).
S: `POST /payments/:reference/verify` (return from redirect) · `GET /payments/:reference`. Webhook: `POST /webhooks/payments/:provider`.
A [finance.view]: `GET /transactions` (admin "Transactions": payments + refunds, export CSV).

#### `payments/payment-methods` (customer saved methods)
Model: `SavedPaymentMethod` (customer, type `card|bank`, brand, last4, expMonth/Year, holder, bank name/account masked, provider authorization token, isDefault, nickname).
S: `GET /me/payment-methods` · `POST /me/payment-methods` (card = ₦50–100 authorisation charge via provider then refunded — **raw card numbers never touch our server**) · `PATCH /:id {nickname, isDefault}` ("Rename card", "Set as default") · `DELETE /:id`.
*The UI form today collects card number/CVV directly and offers PayPal — see issue U5.*

#### `payments/wallets`
Models: `Wallet` (customer, balance, frozen), `WalletTransaction` (kind `topup|refund|credit|adjustment|spend|withdrawal|expiry`, status `pending|completed|failed|reversed`, amount, balanceAfter, reference, channel, note), `WithdrawalRequest` (amount, bank account, status, provider transfer ref).
| | Endpoint | Screen |
|---|---|---|
| S | `GET /me/wallet` (balance, total spent) · `GET /me/wallet/transactions` | /account/wallet |
| S | `POST /me/wallet/topup {amount ≥ ₦500, method}` → payment intent | /account/wallet/topup |
| S | `POST /me/wallet/withdraw {amount ≥ ₦1,000, bankAccountId}` | /account/wallet/withdraw |
| S | `GET /banks` · `POST /banks/resolve` | bank picker / account-name check |
| A | `GET /wallets/transactions` (tabs by kind) · `POST /wallets/adjust {customerId, amount, note}` [customers.wallet] · `POST /wallets/transactions/:id/approve | mark-failed | reverse` · `POST /wallets/:customerId/freeze | unfreeze` · export | /wallets |
Balance changes only through `walletService.post()` inside a transaction with a row lock → no negative balances, every change has a ledger journal.

#### `payments/payouts` (provider settlements to the business bank)
Models: `Payout` (provider, reference, status `scheduled|in_transit|paid|failed|on_hold`, gross, fees, refunds, adjustments, net, bank, scheduledAt, paidAt, notes, failureReason), `PayoutLine` (payment, gross, fee, net).
A [finance.payouts]: list (tabs) · `POST /payouts` (manual) · `PATCH /:id` · `POST /:id/mark-paid | mark-failed | retry | hold | release` · `DELETE` · export · `GET /payouts/providers` ("Manage providers" = payment-method settings).
Job `payouts.sync` pulls settlements from the provider daily (mock generates them).

#### `payments/ledger` (double-entry accounting)
Models: `LedgerAccount` (code, name, type `asset|liability|equity|revenue|expense`, archived), `JournalEntry` (date, reference, description, source `order|refund|payout|fee|adjustment|tax|wallet|manual`, status `draft|posted|void`, createdBy, attachments), `JournalLine` (account, debit, credit, memo).
Automatic postings: order paid (Dr Cash/Clearing, Cr Revenue, Cr VAT payable), refund, provider fee, payout, wallet top-up (Cr **Customer wallet liability**), wallet spend, points redemption.
A [finance.ledger]: accounts list/add · entries list/filter · `POST /ledger/entries` (manual, must balance) · `PATCH /:id` (draft only) · `POST /:id/post` · `POST /:id/void` · `GET /ledger/trial-balance` (+ export).
The prototype's "Reseed" button is dev-only (`/admin/dev/*`, disabled in production).

### 5.6 Loyalty

#### `loyalty/club` (ASL Club)
Models: `ClubTier` (id `Standard|Silver|Gold|Signature`, name, colour, minSpend, pointsMultiplier, perks[], active), `ClubRules` (earnPerNaira, pointValueNaira, birthday/referral/review/signup bonuses, expiryMonths), `ClubReward` (title, description, cost, category `shipping|credit|experience|product|concierge`, eligibleTiers, stock, active), `PointsEntry` (customer, delta, reason, source ref, expiresAt), `RewardRedemption` (reward, points, result: wallet credit / minted coupon code / fulfilment request).
| | Endpoint | Screen |
|---|---|---|
| S | `GET /me/club` (tier, points, progress "7,550 pts to Platinum", perks) | account header card, /account/benefits |
| S | `GET /me/points` (history) | /account/rewards |
| S | `GET /club/rewards` · `POST /club/rewards/:id/redeem` → returns wallet credit, coupon code or confirmation | /account/rewards/redeem |
| A | `GET/PATCH /club/tiers/:id` · `GET/PUT /club/rules` · rewards CRUD + duplicate · `POST /club/points/adjust {customerId, delta, reason}` · `GET /club/ledger` [customers.edit] | /club |
Jobs: nightly tier recalculation (rolling spend), birthday bonus, points expiry.

#### `loyalty/referrals`
Models: `ReferralProgram` (singleton config), `Advocate` (customer, code `JOHN-ASL10`, status `active|paused|banned`, cached stats), `Referral` (advocate, friend name/email/customer, channel, status `pending|qualified|rewarded|expired|flagged`, order, spend, reward, fraudScore, note), `ReferralClick`.
| | Endpoint | Screen |
|---|---|---|
| S | `GET /me/referrals` (code, link, invited/joined/earned, recent invites) | /account/referrals |
| S | `GET /r/:code` (public — records click, sets 30-day cookie, redirects) · code accepted at register | share link |
| A | `GET/PUT /referrals/config` · `GET /referrals/advocates` · `PATCH /advocates/:id/status` · `GET /referrals` · `PATCH /:id/status` · `POST /:id/approve | reject` [marketing.manage] | /referrals |
Qualification on the friend's first paid order ≥ qualifyingSpend; auto-approve under fraud threshold; reward = wallet credit / coupon / points for both sides.

### 5.7 Concierge (sourcing service)

The UI has three related flows; the backend joins them into **one request lifecycle**:

```
start-request form ─┐                     ┌─ quote sent ── customer accepts ── deposit/full payment ─┐
concierge-shop item ─┴─► ConciergeRequest ─┤                                                          ├─► ordered → in transit → delivered
                                           └─ chat thread (customer ⇄ agent, attachments, quote cards) ┘
```

#### `concierge/requests`
Models: `ConciergeRequest` (number `ASL123456`, customer, category, brand, itemName, reference/link, description, size, colour, condition, budget, preferred source, notes, images, status, priority `Standard|Priority|VIP`, assignee, slaDueAt, source `form|catalog`), `ConciergeTimelineEntry` (note|status|message|quote, by, at).
Unified status: `new → sourcing → quoted → approved → payment_pending → ordered → in_transit → delivered`, plus `cancelled`, `unavailable`.
| | Endpoint | Screen |
|---|---|---|
| S | `POST /concierge/requests` (multipart: fields + up to 5 images) | /start-request ("Request submitted…") |
| S | `GET /me/concierge/requests?status=` · `GET /me/concierge/requests/:id` | /account/requests, account track request |
| S | `POST /concierge/requests/lookup {requestId, email?}` | /track-request (guest/public) |
| S | `POST /me/concierge/requests/:id/cancel` | |
| A | `GET /concierge/requests` (inbox: unassigned, SLA breached, VIP, pipeline value) · `GET /:id` [concierge.view] | /concierge/inbox |
| A | `POST /:id/assign` [concierge.assign] · `PATCH /:id/status` · `PATCH /:id/priority` · `POST /:id/notes` | inbox, sourcing board (drag between columns) |
| A | `GET /concierge/board` (grouped by status) | /concierge/board |
Jobs: SLA timer → `concierge_sla` notification rule; auto-cancel quotes past expiry.

#### `concierge/quotes`
Model: `ConciergeQuote` (request, items[{name, price, qty, source}], serviceFee (UI: ₦50,500), shippingEstimate (UI: ₦35,000), tax, total, depositPct, deposit, expiresAt, status `sent|accepted|declined|expired|paid`).
S: `GET /me/concierge/quotes/:id` · `POST /:id/accept` → payment intent (deposit or full) · `POST /:id/decline`.
A [concierge.quote]: `POST /concierge/requests/:id/quotes` ("Send quote") · `GET /concierge/quotes` (+ export CSV) · `PATCH /:id` · `POST /:id/expire`.

#### Concierge cart + payment (`concierge/concierge-catalog`)
The customer "concierge cart" (/concierge/cart → /concierge/payment → /concierge/success) holds **items the concierge team is sourcing or has priced** (statuses `Sourcing in Progress | Payment Pending | Ready to Purchase`).
Backend view: concierge cart = the customer's open requests/quote lines.
S: `GET /concierge/catalog/categories` · `GET /concierge/catalog/:category/products` (concierge-shop) · `POST /concierge/cart/items {productId, size, colour}` (creates a `catalog`-sourced request) · `GET /concierge/cart` · `PATCH/DELETE /concierge/cart/items/:id` · `POST /concierge/checkout` (contact, address, payment) → payment intent → `/concierge/success`.

#### `concierge/chat`
Models: `ChatThread` (request, customer, pinned, unread counts per side, lastAt), `ChatMessage` (sender `customer|agent|system`, author, channel `app|email|whatsapp|sms`, text, attachments, quoteRef, readAt).
S: `GET /me/concierge/requests/:id/messages` · `POST …/messages` (text + attachments) · `POST …/read` · socket `thread:{id}` (typing, new message).
A: `GET /concierge/threads` · `GET /:id/messages` · `POST /:id/messages` (with optional quote card) · `POST /:id/read` · `POST /:id/pin` [concierge.view].
*Inbound WhatsApp/SMS/email into the same thread = later adapter; the model already carries `channel`.*

#### `concierge/suppliers`
Model: `Supplier` (name, contact, email, phone, country, city, categories[], brands[], tier `diamond|platinum|gold|silver`, status `active|paused|blocked|pending`, leadTimeDays, onTimeRate, fulfillmentRate, totalOrders, totalSpend, rating, paymentTerms, currency `USD|EUR|GBP|NGN`, vip, notes).
Optional link `ConciergeRequest.supplierId` + `SupplierOrder` (cost, currency, status) so supplier KPIs are computed rather than typed in.
A [concierge.view]: list (tier/status tabs, export) · `POST` · `PATCH /:id` (notes, status) · `POST /:id/vip` · `DELETE`.

### 5.8 Support

#### `support/tickets`
Models: `Ticket` (number `#5201`, subject, status `open|pending|on_hold|resolved|closed`, priority `low|normal|high|urgent`, channel `email|chat|whatsapp|instagram|phone`, category `order|delivery|returns|payment|product|concierge|account|other`, customer / guest name+email, orderRef, assignee, tags[], slaDueAt, firstResponseAt), `TicketMessage` (author `customer|agent|system`, body, internal note flag, attachments).
| | Endpoint | Screen |
|---|---|---|
| S | `POST /support/tickets` (logged in) | /account/help/contact (topic + message → "Request Received", reference) |
| S | `POST /support/contact` (guest: name, email, subject, message) | /customer-care/contact-us |
| S | `GET /me/tickets` · `GET /me/tickets/:id` · `POST /me/tickets/:id/messages` · `POST /me/tickets/:id/reopen` | /account/tickets, /account/tickets/:id |
| S | `GET /support/help-topics` · `GET /support/help-topics/:slug` | /account/help, /account/help/:topic (FAQ articles from **faqs** module) |
| A | `GET /tickets?status=&q=` · `GET /:id` · `POST /:id/reply {body, internal}` · `PATCH /:id/status | priority` · `POST /:id/assign` · `POST /:id/tags` [support.tickets / support.reply] | /tickets |
Email replies from customers re-enter the thread later via an inbound-email webhook.

#### `support/feedback`
Model: `Feedback` (customer, type `idea|bug|praise`, area, message, reply email, status `new|triaged|done`).
S: `POST /feedback` (/account/feedback). A: `GET /feedback` · `PATCH /:id/status` — *no admin screen exists yet (issue U7)*.

#### `support/notifications` (customer inbox + preferences)
Models: `Notification` (customer, category `Orders|Offers|Account|Wishlist|ASL Club|Updates`, tag, title, message, cta label, cta link, readAt, icon key), `NotificationPreference` (channels push/email/sms; topics orders/concierge/shipping/promos/wishlist), `PushToken`.
S: `GET /me/notifications?category=` · `POST /me/notifications/:id/read` · `POST /me/notifications/read-all` · `GET /me/notifications/unread-count` (bell badge) · `GET/PUT /me/notification-preferences`.
Producer: `notify(customerId, template, data)` — writes inbox row + sends via enabled channels, respecting preferences and quiet hours.

### 5.9 Marketing

#### `marketing/segments`
Model: `Segment` (name, description, colour, match `all|any`, rules `Json` — fields `spend, orders, aov, concierge, tier, status, country, city, tags, marketingOptIn, lastOrderAt, createdAt`), pinned, system.
Service compiles rules → Prisma `where` on customers (+ aggregates table, below).
A [marketing.manage]: CRUD · duplicate · pin · `GET /:id/preview` (count + sample customers) · `GET /:id/customers` (export).

#### `marketing/campaigns`
Model: `Campaign` (name, subject, preheader, channel `email|push|sms|whatsapp|inapp`, status `draft|scheduled|sending|sent|paused|archived`, goal, segment, schedule, body, cta, utm, tags, pinned) + `CampaignStat` (sent, delivered, opened, clicked, converted, revenue, unsubscribed) + `CampaignRecipient` (per-customer delivery state).
A [marketing.manage]: CRUD · duplicate · pin · `PATCH /:id/status` (schedule / pause / resume / archive) · `POST /:id/send-test` · `POST /:id/send-now`.
Jobs: scheduled send → fan-out in batches through providers; tracking pixel + redirect `GET /t/o/:token`, `GET /t/c/:token`; unsubscribe link `GET /unsubscribe/:token`; conversions attributed by UTM / last click within 7 days.

#### `marketing/messaging` (transactional templates + push blasts)
Models: `MessageTemplate` (code e.g. `order.confirmed`, name, channel, category `transactional|lifecycle|concierge|system`, status `active|draft|paused`, trigger, subject, preheader, body with `{{variables}}`, cta, link, stats), `PushBlast` (title, body, audience, status, scheduledFor, recipients, opens).
A [marketing.manage]: templates list · `PATCH /:id` · duplicate · `PATCH /:id/status` · `POST /:id/preview` (render with sample data) · `POST /:id/test` · blasts CRUD · `POST /blasts/:id/send-now`.
Every system email/SMS/push in this document is rendered from these templates (seeded with the codes the backend uses).

#### `marketing/banners`, `marketing/announcements`, `marketing/slots`
These three feed the storefront chrome and home page:

| Module | Model (key fields) | Storefront endpoint | Admin actions |
|---|---|---|---|
| banners | `Banner`: placement `top_bar|checkout|cart_nudge|category_ribbon|product_ribbon|concierge_strip`, priority, status, device, audience, message, cta, link, colours, style, icon, dismissible, schedule, counters | `GET /store/banners?placement=&device=` | CRUD, duplicate, status, reorder within placement, move up/down |
| announcements | `Announcement`: title, message, emoji, cta, style, colours, placement `site_top|checkout_top|admin_top`, audience `everyone|guests|members|club_gold|club_signature`, device, dismissible, priority, schedule, status, counters | `GET /store/announcements` (filtered by audience of the caller) | CRUD, duplicate, status |
| slots | `Slot`: page `home|shop|sales|concierge|brands`, position, type `hero|banner|grid|carousel|editorial|countdown`, status, device, audience, headline, subhead, cta, link, image, accent, schedule, counters, pinned | `GET /store/slots?page=home` (used by `GET /home`) | CRUD, duplicate, status, pin, reorder, move |

All three: `POST /store/impressions` batch endpoint `{ kind, id, event: impression|click|dismiss }` updates counters (Redis counters flushed to MySQL every minute). Scheduled `startsAt/endsAt` handled by a job that flips status `scheduled → live → expired`.

### 5.10 Customers and addresses

#### `identity/customers` (admin view of customers)
Models: `Customer` (name, email, phone, city, country, tier, status `active|vip|flagged|blocked`, marketingOptIn, DOB, gender, avatar, preferences, referredBy), `CustomerNote`, `CustomerTag`, `CustomerStats` (orders, concierge count, spend, AOV, lastOrderAt — **maintained by events**, so segments and tables don't run heavy aggregates).
A [customers.view / customers.edit]: `GET /customers` (tabs All/Active/VIP/Flagged/Blocked, search, sort) · `GET /:id` (profile, orders, concierge, wallet, points, addresses, notes, tickets) · `PATCH /:id/status | tier` · `POST /:id/marketing` · `POST/DELETE /:id/notes` · `POST/DELETE /:id/tags` · `POST /:id/wallet-adjust` [customers.wallet] · `DELETE /:id` (anonymise) · export.

#### `platform/addresses`
Model: `Address` (customer, label `Home|Work|Other`, type `shipping|billing|pickup`, recipient, phone, line1, line2, city, state, country, postalCode, isDefault, verified, flagged, notes, lastUsedAt, ordersShipped).
S: `GET /me/addresses` · `POST` · `PATCH /:id` · `DELETE /:id` · `POST /:id/default` (/account/addresses, /account/addresses/new, checkout address prefill).
A [customers.edit]: `GET /addresses` (tabs shipping/billing/pickup/flagged/unverified, search) · `PATCH /:id` · `POST /:id/verify` · `POST /:id/flag` · `POST /:id/default` · `DELETE` · export CSV.

### 5.11 Content

#### `content/pages` (CMS)
Model: `Page` (title, slug, template `standard|legal|landing|story|help`, status, visibility `public|unlisted|members`, author, SEO fields, ogImage, showInHeader, showInFooter, tags, blocks `Json` [`hero|rich_text|image|gallery|cta|faq|video|columns|quote`], publish/schedule).
S: `GET /content/pages/:slug` — serves all **customer-care** pages (about-us, privacy, terms, cookie, refund, return, shipping, our-commitment, how-it-works) and `/how-it-works`, `/concierge-service` copy. `GET /content/navigation` (header/footer links).
A [content.publish]: CRUD · duplicate · status · blocks add/update/remove/move · `GET /:id/preview`.
*Today those pages are hard-coded in the UI. Seeding them into the CMS and rendering from blocks is part of the frontend integration work — see issue U6.*

#### `content/faqs`
Models: `FaqCategory` (name, slug, description, icon, order), `FaqItem` (category, question, answer, status, order, featured, tags, views, helpful/notHelpful, author).
S: `GET /content/faqs?category=` (/faq, /customer-care/faqs, account help) · `POST /content/faqs/:id/feedback {helpful}` · `POST /content/faqs/:id/view`.
A [content.publish]: categories add/update/remove/move · items add/update/remove/duplicate/status/feature/move.

#### `content/blog`
Models: `BlogPost` (title, slug, excerpt, content, cover, category, author, tags, status, featured, readingMinutes, SEO, publish/schedule, counters), `BlogCategory`, `BlogAuthor`.
S: `GET /content/blog` · `GET /content/blog/:slug` · `POST /content/blog/:id/like`.
A [content.publish]: CRUD · duplicate · status · feature · categories CRUD.
*Admin can manage posts, but `asl-web` has no blog page yet — issue U7.*

#### `content/seo`
Models: `SeoConfig` (title template, default description, site name/url, robots.txt, default OG image, twitter, GA id, GSC verification, autoSitemap, submitToBing), `SeoPage` (path, type, title, description, OG, canonical, index policy, keywords, schema type, Search Console stats), `Redirect` (from, to, 301/302/307/410, enabled, hits, lastHitAt), `SitemapEntry`.
S: `GET /seo/meta?path=` (web SSR head tags) · `GET /robots.txt` · `GET /sitemap.xml` · redirect middleware for the web server (`GET /seo/redirects` cached).
A [content.publish]: config update · pages update · redirects add/toggle/remove · sitemap toggle/update · `GET /seo/audit` (findings: missing titles, long descriptions, broken redirects, duplicate canonicals — computed).

#### `content/media`
Models: `MediaAsset` (name, path/url, type `image|video|document`, folder `products|hero|campaigns|concierge|brand|uncategorized`, sizeKB, width, height, altText, tags, starred, uploadedBy), `MediaUsage` (asset ↔ entity, maintained when other modules reference an asset → "used in").
A [content.publish]: `POST /media` (multi-upload) · `GET /media?folder=&q=&type=` · `PATCH /:id` (alt, tags, name) · `POST /:id/star` · `POST /media/move {ids, folder}` · `DELETE /:id` · `POST /media/bulk-delete` (blocked if used, unless `force`).
Storage: `LocalDiskDriver` writes `uploads/{yyyy}/{mm}/{cuid}.{ext}` + generated sizes (`sm 320`, `md 800`, `lg 1600`, WebP); served at `/uploads/...` with long cache headers.

### 5.12 Platform

#### `platform/settings`
Singleton rows (one table per group, or one `Setting` key/value `Json` table with typed accessors):
`StoreProfile` (legal/display name, support email/phone/WhatsApp, address, timezone, currency, weight unit, logo, favicon), `BrandTheme` (colours, radius, fonts — the apps can theme from it later), `CheckoutSettings` (guest checkout, require phone, gift message, auto-apply best coupon, min/max order, abandon minutes, taxes included), `PaymentMethodSetting` (Paystack, Flutterwave, Stripe, Wallet, Bank Transfer, Cash on Delivery: enabled, test mode, fee label), `Locale`, `Currency` (rate, enabled, default), `LegalSettings`, `Maintenance` (on, message).
S: `GET /settings/public` (cached 60 s): store profile, enabled payment methods, locales, currencies + rates, checkout flags, maintenance, support contacts, app versions.
A [settings.manage]: `PATCH /settings/profile | brand | checkout | legal` · `POST /settings/payment-methods/:id/toggle {enabled|testMode}` · locales toggle/default · currencies toggle/default/rate · `POST /settings/fx/refresh` · `POST /settings/maintenance`.
Maintenance mode → middleware returns `MAINTENANCE_MODE` on `/store/*` (admin still works).

#### `platform/notification-settings` (internal staff alerts)
Models: `NotificationRule` (event key e.g. `order_high_value`, category, label, channels {email, push, in_app, slack, sms}, recipients (roles or emails), priority, enabled), `NotificationChannelConfig`, `QuietHours`, `DigestSettings`, `AdminNotification` (in-app bell for staff).
A [settings.manage]: rules toggle / channel toggle / priority / recipients · channels/quiet hours/digest update · `POST /notification-settings/test/:channel` ("Test email queued", "Slack test posted"…) · `GET /admin/notifications` (bell) · `POST /:id/read`.

#### `platform/audit` and `platform/activity`
`AuditEvent` (actor, role, action, category, severity, entity, entityId, summary, IP, location, device, before, after) — written by middleware + services.
A [audit.view]: `GET /audit?category=&severity=&actor=&from=&to=` · `GET /audit/export`.
`ActivityEntry` (type `order.placed|order.shipped|order.refunded|concierge.requested|concierge.quoted|concierge.approved|catalog.updated|review.submitted|coupon.minted|payout.pending|stock.low|system`, title, meta, amount) — produced from the event bus.
A: `GET /activity` + socket room `admin:activity` (/activity live feed, dashboard ticker).

#### `platform/reports`
Models: `SavedReport` (name, description, category, owner, favorite, schedule `off|daily|weekly|monthly`, formats, recipients, query definition), `ReportRun` (status `queued|running|ready|failed`, format, rows, size, file path, requestedBy).
A [analytics.view]: library CRUD · favorite · `POST /:id/run {format}` (queued → worker builds CSV/XLSX/PDF → stored via StorageDriver) · `GET /reports/runs` · `GET /runs/:id/download` · export run log. Scheduled runs email the file to recipients.
Report types are code-defined generators (sales summary, VAT, wallet liabilities, inventory valuation, concierge pipeline, customer list…).

#### `platform/analytics` and `platform/dashboard`
Two sources:
1. **Business data** already in MySQL (orders, items, refunds, customers, concierge) → aggregated by SQL into **daily rollup tables** (`DailySales`, `DailyProductStats`, `DailyConciergeStats`) built by a nightly + hourly job, so dashboards stay fast.
2. **Traffic** (visitors, sessions, sources, devices, product views, add-to-cart, conversion) — the apps send events: `POST /store/events` (batched: `page_view`, `product_view`, `add_to_cart`, `checkout_start`, `search`, with anonymous id, UTM, device). Stored in `AnalyticsEvent` (partitioned by month) + rolled up into `DailyTraffic`.

A [analytics.view]:
| Endpoint | Screen |
|---|---|
| `GET /dashboard?range=7d|14d|30d|90d` (KPIs, revenue chart, top products, recent orders, concierge pipeline, low stock) | / (Dashboard), "Export report" |
| `GET /analytics/sales?range=&channel=&country=` (series, channel split, country split, category split, product table) | /analytics/sales |
| `GET /analytics/products?range=&category=&sort=` (revenue, units, views, conversion, margin) | /analytics/products |
| `GET /analytics/traffic?range=&device=&source=` | /analytics/traffic |
| `GET /analytics/cohorts?window=6m|12m|24m&metric=retention|revenue|orders` | /analytics/cohorts |
| `GET /analytics/concierge?range=&priority=` | /analytics/concierge |
Margin needs product **cost** (inventory `cost`) — already in the stock model.

#### `platform/app-config`
S: `GET /app/config` — onboarding slides, splash, home section toggles, minimum supported app version (force-update prompt for the mobile app), feature flags.
S: `POST /app/consent` (cookie consent choices for the PWA — stored for compliance), `POST /app/download-offer/claim` (the web "download our app" offer).
A [settings.manage]: `PATCH /app/config`.

#### `platform/global-search` (admin ⌘K command palette)
A: `GET /search/global?q=` → top matches across orders (number, email), customers, products (name, SKU), concierge requests, tickets — each result filtered by the caller's permissions.

---

## 6. Data model (Prisma, MySQL)

The schema is split into one Prisma file per domain (`prisma/schema/*.prisma`, multi-file schema). About **140 tables** in total.

| Schema file | Models |
|---|---|
| `identity.prisma` | Customer, CustomerSession, CustomerTwoFactor, PasswordResetToken, OtpCode, PushToken, CustomerNote, CustomerTag, CustomerStats, AdminUser, AdminSession, AdminInvite, RolePermissionOverride |
| `catalog.prisma` | Product, ProductVariant, ProductColor, ProductImage, ProductSizeLabel, ProductFeature, Category, Subcategory, Brand, Collection, CollectionProduct, SizeGuide, Review, ReviewPhoto, ReviewReply, ReviewVote, ReviewReport, Drop, Reservation, BackInStockAlert, SearchLog |
| `inventory.prisma` | Warehouse, StockLevel, StockMovement |
| `commerce.prisma` | Cart, CartItem, WishlistItem, CheckoutSession, Order, OrderItem, OrderEvent, OrderNote, DraftOrder, DraftOrderItem, ReturnRequest, ReturnItem, ReturnEvent, Coupon, CouponTarget, CouponRedemption, CustomerCoupon, RecoveryRule |
| `fulfilment.prisma` | ShippingZone, ZoneRate, Shipment, ShipmentEvent, PickupLocation, PickupBooking, TaxRate, TaxCategory, TaxCategoryOverride, TaxExemption, TaxSettings |
| `payments.prisma` | Payment, Refund, WebhookLog, SavedPaymentMethod, BankAccount, Wallet, WalletTransaction, WithdrawalRequest, Payout, PayoutLine, LedgerAccount, JournalEntry, JournalLine |
| `loyalty.prisma` | ClubTier, ClubRules, ClubReward, PointsEntry, RewardRedemption, ReferralProgram, Advocate, Referral, ReferralClick |
| `concierge.prisma` | ConciergeRequest, ConciergeImage, ConciergeTimelineEntry, ConciergeQuote, ConciergeQuoteLine, ChatThread, ChatMessage, ChatAttachment, Supplier, SupplierOrder |
| `support.prisma` | Ticket, TicketMessage, TicketTag, Feedback, Notification, NotificationPreference |
| `marketing.prisma` | Segment, Campaign, CampaignStat, CampaignRecipient, MessageTemplate, PushBlast, Banner, Announcement, Slot |
| `content.prisma` | Page, FaqCategory, FaqItem, BlogPost, BlogCategory, BlogAuthor, SeoConfig, SeoPage, Redirect, SitemapEntry, MediaAsset, MediaUsage |
| `platform.prisma` | Setting (typed JSON per group), Locale, Currency, NotificationRule, AdminNotification, AuditEvent, ActivityEntry, SavedReport, ReportRun, AnalyticsEvent, DailySales, DailyProductStats, DailyTraffic, DailyConciergeStats, IdempotencyKey, AppConfig, ConsentRecord, Address |

### 6.1 Schema conventions

- `id String @id @default(cuid())`; human numbers in their own `@unique` column (`number String @unique`), generated from a `Sequence` table inside the same transaction (no gaps under concurrency).
- `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`, `deletedAt DateTime?` where soft delete applies.
- Money: `Int` kobo (fits ₦21M per value); `BigInt` for ledger and stats totals.
- Enums: Prisma `enum`s using **one** canonical set per concept (section 13 lists where the UI disagrees with itself).
- Indexes on every foreign key and every column the admin tables filter/sort on (`status`, `createdAt`, `customerId`, `number`, `email`).
- FULLTEXT index on `Product(name, description)`, `Brand(name)`, and `Customer(name, email)` for search.
- `Json` only for genuinely flexible shapes: page blocks, segment rules, smart-collection rules, audit before/after, report query definitions, settings groups.

### 6.2 Example — orders (shows the style)

```prisma
model Order {
  id              String        @id @default(cuid())
  number          String        @unique              // ASL-ORD-10248
  customerId      String?
  customer        Customer?     @relation(fields: [customerId], references: [id])
  guestEmail      String?
  channel         SalesChannel                       // web | mobile | pwa | concierge | draft
  status          OrderStatus   @default(pending_payment)
  paymentStatus   PaymentStatus @default(unpaid)
  deliveryMethod  DeliveryMethod                     // ship | pickup
  subtotal        Int
  discount        Int           @default(0)
  shipping        Int           @default(0)
  tax             Int           @default(0)
  walletApplied   Int           @default(0)
  total           Int
  couponCode      String?
  contact         Json                               // snapshot {email, phone, subscribe}
  shippingAddress Json?                              // snapshot, so later address edits don't rewrite history
  pickupLocationId String?
  placedAt        DateTime      @default(now())
  items           OrderItem[]
  events          OrderEvent[]
  notes           OrderNote[]
  payments        Payment[]
  shipments       Shipment[]
  returns         ReturnRequest[]
  reservation     Reservation?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt

  @@index([customerId, placedAt])
  @@index([status, placedAt])
}
```

---

## 7. Key flows (cross-module)

### 7.1 Place order (cart → paid)
1. `POST /store/checkout/place-order` with `Idempotency-Key`.
2. **One DB transaction**: lock cart → re-price items → `inventoryService.reserve()` (row locks; fail → `OUT_OF_STOCK` with the item list the cart page already knows how to show) → `couponsService.lock()` → shipping + tax → create `Order` (`pending_payment`) + items + event.
3. Outside the transaction: `paymentsService.createIntent({ purpose: "order" })` → return redirect/access code. Wallet-only orders skip the provider.
4. Webhook or `verify` → `payment.succeeded` → order `paid` → stock reservation becomes `sale` → coupon redemption committed → ledger journal → events: email/SMS/push, points, referral check, activity, admin notification rule.
5. Unpaid after 30 min (job) → order `cancelled`, stock and coupon released.

### 7.2 Drop reservation
Reserve → deposit intent (`reservation_deposit`) → on success reservation `reserved`, drop `reservedCount++` (capped by allocation, row lock) → at `releaseAt` job notifies → `pay-balance` intent → order created as paid with `reservation` link → after N days unpaid → `expired`, deposit handled per policy (decision D4).

### 7.3 Return and refund
Customer submits → `requested` → admin approves (return instructions email) → `in_transit_back` → `received` (inspection; stock movement `return`) → `refunded` via `paymentsService.refund()` (original method) **or** wallet credit → ledger → customer notification. Reject path at any point before refund.

### 7.4 Concierge
Request created (form or concierge cart) → agent assigned (manual or round-robin) → sourcing → quote sent (chat card + email, expiry) → customer accepts → payment intent (deposit or full) → `ordered` (optional supplier order) → `in_transit` → `delivered` (balance captured if deposit). SLA timers at each waiting state.

### 7.5 Wallet
Top-up: intent → webhook → `WalletTransaction(topup, completed)` + ledger. Spend at checkout: debit inside the order transaction. Withdrawal: request (pending, funds held) → admin approve (or auto under a limit) → provider transfer → webhook → completed / failed (funds released). Freeze blocks all debits.

### 7.6 Points and tiers
`order.paid` → points = floor(total ÷ earnPerNaira) × tier multiplier, `expiresAt` = now + expiryMonths. Redemption deducts points in one transaction with the reward result (wallet credit, minted coupon, or a fulfilment task). Nightly: tier from rolling 12-month spend, expiry sweep, birthday bonus.

---

## 8. Background jobs and events

| Queue / job | Trigger | Does |
|---|---|---|
| `notifications.send` | any `notify()` | renders template, sends email/SMS/push/in-app, respects preferences + quiet hours |
| `orders.expire-unpaid` | delayed 30 min after create | cancels unpaid order, releases stock/coupon |
| `carts.abandon-scan` | every 15 min | marks carts abandoned, schedules reminder 1 / 2 by recovery rules |
| `drops.release` / `reservations.expire` | at `releaseAt` / after grace | opens drop, notifies, expires unpaid balances |
| `concierge.sla` / `tickets.sla` | delayed per item | breach warnings → staff notification rules |
| `quotes.expire` | at `expiresAt` | marks quote expired, notifies |
| `content.schedule` | every minute | publishes/expires pages, posts, collections, banners, slots, announcements, coupons |
| `campaigns.send` | at `scheduledAt` / send-now | segment snapshot → batched fan-out → stats |
| `reports.run` | on demand / schedule | builds file, stores it, emails recipients |
| `analytics.rollup` | hourly + nightly | refreshes daily rollup tables |
| `loyalty.nightly` | 02:00 Africa/Lagos | tiers, points expiry, birthdays |
| `payouts.sync` | daily | settlement import from provider |
| `counters.flush` | every minute | banner/slot/announcement/faq counters Redis → MySQL |
| `customers.anonymise` | daily | deleted accounts past 30 days |
| `media.thumbnails` | on upload | sharp resizes |

In-process **events** (typed): `customer.registered`, `order.placed`, `order.paid`, `order.status_changed`, `order.refunded`, `return.updated`, `payment.succeeded|failed`, `wallet.changed`, `review.submitted|published`, `concierge.requested|quoted|approved|status_changed`, `ticket.created|replied`, `stock.low`, `coupon.minted`, `referral.qualified`. Each listener is in the module that cares (e.g. `loyalty/club` listens to `order.paid`).

---

## 9. Screen coverage — every route → endpoints

Layout-only routes (`account.tsx`, `checkout.tsx`, `shop.tsx`, `customer-care.tsx`, and the `*.tsx` parents that only render `<Outlet/>`) need nothing beyond what their children use, plus `GET /store/me` (auth gate), `GET /store/settings/public` and `GET /store/announcements` (global chrome, cart badge, notification badge).

### 9.1 Customer — `asl-web` and `asl-mobile` (same screens)

| Route | Endpoints (all under `/api/v1/store`) |
|---|---|
| `/` (home) | `GET /home` (slots, categories, best sellers, trending, collections), `GET /banners`, `POST /events` |
| `/splash`, `/onboarding` | `GET /app/config`, `POST /me/onboarding/complete` |
| `/auth` + login modal | `POST /auth/register · login · login/2fa · otp/request · otp/verify · password/forgot · password/reset · refresh · logout`, `POST /cart/merge`, `POST /wishlist/merge` |
| `/shop` | `GET /categories`, `GET /products?…`, `GET /products/facets` |
| `/shop/:category` | `GET /categories/:handle`, `GET /products?category=…`, `GET /products/facets` |
| `/shop/browse` | `GET /categories` (tree) |
| `/shop/sales` | `GET /slots?page=sales`, `GET /products?onSale=true…` |
| `/trending`, `/best-sellers`, `/new-arrivals` | `GET /products?sort=trending | best_selling | newest` |
| `/brands`, `/brands/:brand` | `GET /brands`, `GET /brands/:handle`, `GET /products?brand=` |
| `/collection/:slug` | `GET /collections/:handle` |
| `/search` | `GET /search`, `GET /search/suggest`, `GET /search/popular`, `GET /products?sort=trending` |
| `/product/:id` (+ quick view, quick add, size guide, reviews, write review, share, notify me) | `GET /products/:id`, `GET /products/:id/related`, `GET /size-guides`, `GET /products/:id/reviews`, `POST /products/:id/reviews` (+ photo upload), `POST /reviews/:id/helpful · report`, `POST /cart/items`, `POST /wishlist`, `POST /products/:id/notify-me`, `GET /shipping/estimate` |
| `/coming-soon`, `/drop/:dropId` | `GET /drops`, `GET /drops/:id`, `POST /drops/:id/reserve` |
| `/cart` | `GET /cart`, `PATCH/DELETE /cart/items/:id`, `POST /cart/remove-unavailable`, `GET /checkout/totals`, `GET /products/:id/also-like` |
| `/checkout/information` | `GET /checkout`, `PUT /checkout/contact`, `PUT /checkout/delivery`, `GET /checkout/shipping-options`, `GET /pickup-locations`, `GET /me/addresses` |
| `/checkout/payment` | `PUT /checkout/payment`, `GET /me/coupons`, `POST/DELETE /checkout/coupon`, `GET /me/payment-methods`, `GET /me/wallet` |
| `/checkout/review` | `GET /checkout`, `GET /checkout/totals` |
| `/checkout/place-order` | `POST /checkout/place-order`, `POST /payments/:reference/verify` |
| `/checkout/confirmation` | `GET /me/orders/:id` (or guest lookup token) |
| `/concierge-service` | `GET /content/pages/concierge-service`, `GET /concierge/catalog/categories` |
| `/concierge-categories`, `/concierge-shop/:category` | `GET /concierge/catalog/categories`, `GET /concierge/catalog/:category/products`, `POST /concierge/cart/items` |
| `/concierge-brands` | `GET /concierge/brands` |
| `/concierge/cart` | `GET /concierge/cart`, `PATCH/DELETE /concierge/cart/items/:id`, `DELETE /concierge/cart` |
| `/concierge/payment`, `/concierge/success` | `POST /concierge/checkout`, `POST /payments/:reference/verify`, `GET /me/concierge/requests/:id` |
| `/start-request` | `GET /concierge/catalog/categories`, `POST /concierge/requests` (multipart) |
| `/track-request` | `POST /concierge/requests/lookup` |
| `/how-it-works`, `/faq` | `GET /content/pages/how-it-works`, `GET /content/faqs`, `POST /content/faqs/:id/feedback` |
| `/account` | `GET /me`, `GET /me/club`, `GET /me/wallet`, `GET /me/orders?limit=1`, `GET /me/notifications/unread-count`, `GET /wishlist` (count) |
| `/account/orders`, `/account/orders/:id` | `GET /me/orders`, `GET /me/orders/:id`, `GET /me/orders/:id/tracking`, `GET /me/orders/:id/invoice.pdf`, `POST /orders/:id/pay-balance`, `POST /me/reservations/:id/cancel`, `POST /me/orders/:id/cancel · reorder` |
| `/account/track` | `GET /me/orders/:id/tracking`, `POST /orders/lookup` |
| `/account/requests` | `GET /me/concierge/requests`, `GET /me/concierge/requests/:id/messages`, `POST …/messages` |
| `/account/returns` (+ `/details`, `/policy`, `/how-it-works`) | `GET /me/returns`, `GET /me/orders/:id/returnable`, `POST /me/returns`, `GET /content/pages/return-policy` |
| `/account/benefits` | `GET /me/club`, `GET /club/tiers` |
| `/account/rewards`, `/account/rewards/redeem` | `GET /me/club`, `GET /me/points`, `GET /club/rewards`, `POST /club/rewards/:id/redeem` |
| `/account/wallet` (+ `/topup`, `/withdraw`) | `GET /me/wallet`, `GET /me/wallet/transactions`, `POST /me/wallet/topup`, `POST /me/wallet/withdraw`, `GET /banks`, `POST /banks/resolve` |
| `/account/payment-methods` (+ `/new`) | `GET/POST /me/payment-methods`, `PATCH/DELETE /me/payment-methods/:id` |
| `/account/notifications` (+ `/settings`) | `GET /me/notifications`, `POST /me/notifications/:id/read · read-all`, `GET/PUT /me/notification-preferences` |
| `/account/details` | `GET/PATCH /me`, `POST /me/avatar` |
| `/account/addresses` (+ `/new`) | `GET/POST /me/addresses`, `PATCH/DELETE /me/addresses/:id`, `POST /me/addresses/:id/default` |
| `/account/wishlist` | `GET /wishlist`, `DELETE /wishlist/:productId`, `GET /products/:id/also-like` |
| `/account/help`, `/account/help/:topic` | `GET /support/help-topics`, `GET /support/help-topics/:slug`, `GET /me/tickets?open=true` (count) |
| `/account/help/contact` | `POST /support/tickets` |
| `/account/tickets`, `/account/tickets/:id` | `GET /me/tickets`, `GET /me/tickets/:id`, `POST /me/tickets/:id/messages · reopen` |
| `/account/referrals` | `GET /me/referrals` (+ share link `GET /r/:code`) |
| `/account/security` | `POST /me/password`, `POST /me/2fa/*`, `GET/DELETE /me/sessions` |
| `/account/settings` | `PATCH /me/preferences`, `POST /auth/logout`, `DELETE /me` |
| `/account/feedback` | `POST /feedback` |
| `/customer-care/about-us · cookie-policy · how-it-works · our-commitment · privacy-policy · refund-policy · return-policy · shipping-policy · terms-of-service` | `GET /content/pages/:slug` (cookie page also `POST /app/consent`) |
| `/customer-care/faqs` | `GET /content/faqs` |
| `/customer-care/contact-us` | `POST /support/contact` |
| `/customer-care/track-order` | `POST /orders/lookup` |
| `/customer-care` (index → redirect) | — |
| Not found page | — |

### 9.2 Admin — `asl-admin`

| Route | Endpoints (all under `/api/v1/admin`) | Permission |
|---|---|---|
| `/login` | `POST /auth/login · login/2fa · refresh · logout`, `POST /auth/invite/accept` | — |
| `/` Dashboard | `GET /dashboard?range=` | analytics.view |
| `/activity` | `GET /activity` + socket `admin:activity` | orders.view |
| `/orders`, `/orders/:id` | `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id/status`, `POST /orders/bulk`, `POST /orders/:id/fulfil · notes · email-invoice · refund`, `GET …/invoice.pdf · packing-slip.pdf`, `GET /orders/export` | orders.* |
| `/drafts` | `GET/POST /draft-orders`, `PATCH/DELETE /draft-orders/:id`, `POST …/duplicate · send · convert`, `POST /draft-orders/import` | orders.edit |
| `/carts` | `GET /carts/abandoned`, `POST /carts/:id/remind`, `POST /carts/remind-bulk`, `GET/PUT /carts/recovery-rules` | marketing.manage |
| `/returns` | `GET/POST /returns`, `POST /returns/:id/approve · reject · mark-received · investigate · refund` | orders.refund |
| `/transactions` | `GET /transactions`, `GET /transactions/export` | finance.view |
| `/concierge/inbox` | `GET /concierge/requests`, `POST …/:id/assign`, `PATCH …/:id/status · priority`, `POST …/:id/notes`, `POST …/:id/quotes` | concierge.* |
| `/concierge/board` | `GET /concierge/board`, `PATCH /concierge/requests/:id/status` | concierge.view |
| `/concierge/chat` | `GET /concierge/threads`, `GET/POST /concierge/threads/:id/messages`, `POST …/read · pin` + socket | concierge.view |
| `/concierge/quotes` | `GET /concierge/quotes`, `PATCH /concierge/quotes/:id`, `POST …/expire`, export | concierge.quote |
| `/concierge/suppliers` | `GET/POST /suppliers`, `PATCH/DELETE /suppliers/:id`, `POST /suppliers/:id/vip`, export | concierge.view |
| `/shipments` | `GET/POST /shipments`, `PATCH/DELETE /shipments/:id`, `POST /shipments/:id/advance`, `POST /shipments/bulk/labels`, export | orders.edit |
| `/pickups` | `GET/POST/PATCH/DELETE /pickup-locations`, `POST /pickup-locations/:id/toggle`, `GET /pickup-bookings`, `POST /pickup-bookings/:id/advance · notes` | orders.edit |
| `/shipping-zones` | zones CRUD, `POST /:id/duplicate · toggle`, `PUT/DELETE /:id/rates/:rateId` | settings.manage |
| `/products` | products CRUD, `POST /products/:id/duplicate`, `PATCH /products/:id/status`, `POST /products/bulk`, `PUT /products/:id/variants · images · sizing · drop`, import/export | catalog.* |
| `/categories` | categories CRUD, status, feature, move, subcategories CRUD | catalog.edit |
| `/brands` | brands CRUD, duplicate, status, tier, feature, concierge-only | catalog.edit |
| `/collections` | collections CRUD, duplicate, status, slot, feature, preview | catalog.edit |
| `/inventory` | `GET /inventory`, `POST /inventory/adjust · transfer`, `PATCH reorder-point`, `GET /inventory/movements`, warehouses CRUD, `PUT /products/:id/sizing` | inventory.adjust |
| `/size-guides` | size guides CRUD | catalog.edit |
| `/media` | `POST /media`, `GET /media`, `PATCH /media/:id`, `POST /media/:id/star`, `POST /media/move · bulk-delete`, `DELETE /media/:id` | content.publish |
| `/reviews` | `GET /reviews`, `PATCH /reviews/:id/status`, `POST /reviews/bulk`, `POST /reviews/:id/reply`, `DELETE /reviews/:id` | catalog.edit |
| `/customers` | customers list/detail, status, tier, marketing, notes, tags, wallet-adjust, delete, export | customers.* |
| `/segments` | segments CRUD, duplicate, pin, preview, customers export | marketing.manage |
| `/club` | tiers, rules, rewards CRUD + duplicate, points adjust, points ledger | customers.edit |
| `/wallets` | wallet transactions list, adjust, approve/mark-failed/reverse, freeze/unfreeze, export | customers.wallet |
| `/addresses` | addresses list, edit, verify, flag, default, delete, export | customers.edit |
| `/campaigns` | campaigns CRUD, duplicate, pin, status, send-test, send-now | marketing.manage |
| `/coupons` | coupons CRUD, duplicate, status, pin, redemptions | marketing.manage |
| `/banners` | banners CRUD, duplicate, status, reorder, move | marketing.manage |
| `/slots` | slots CRUD, duplicate, status, pin, reorder, move | marketing.manage |
| `/announcement` | announcements CRUD, duplicate, status | marketing.manage |
| `/messaging` | templates list/update/duplicate/status/preview/test, push blasts CRUD + send-now | marketing.manage |
| `/referrals` | program config, advocates + status, referrals + status/approve/reject | marketing.manage |
| `/seo` | config, pages, redirects, sitemap, audit | content.publish |
| `/blog` | posts CRUD, duplicate, status, feature, categories CRUD | content.publish |
| `/faqs` | FAQ categories + items CRUD, duplicate, status, feature, move | content.publish |
| `/pages` | pages CRUD, duplicate, status, blocks add/update/remove/move, preview | content.publish |
| `/payouts` | payouts list/create/update/delete, mark-paid/failed, retry, hold, release, export, providers | finance.payouts |
| `/ledger` | accounts, entries CRUD (draft), post, void, trial balance, export | finance.ledger |
| `/tax` | rates CRUD + toggle, categories, exemptions, settings, VAT report | settings.manage |
| `/analytics/sales · products · traffic · cohorts · concierge` | `GET /analytics/*` | analytics.view |
| `/reports` | reports CRUD, favorite, run, runs list, download, run log export | analytics.view |
| `/tickets` | tickets list/detail, reply (internal note), status, priority, assign, tags | support.* |
| `/team` | members invite/update/remove/resend, roles + permission overrides | team.manage |
| `/audit` | `GET /audit`, `GET /audit/export` | audit.view |
| `/notification-settings` | rules, channels, quiet hours, digest, test sends | settings.manage |
| `/settings` | profile, brand, checkout, payment methods, locales, currencies + FX refresh, legal, maintenance | settings.manage |
| Command palette (⌘K) | `GET /search/global?q=` (orders, customers, products, requests, tickets) | per-result permission |
| Top bar bell | `GET /admin/notifications`, `POST /admin/notifications/:id/read` | — |

---

## 10. Docker and environments

`docker-compose.yml` (development):

| Service | Image | Port | Notes |
|---|---|---|---|
| `api` | Node 22 (multi-stage Dockerfile) | 4000 | `tsx watch`, mounts `src/`, `uploads` volume |
| `worker` | same image, `node dist/worker.js` | — | BullMQ workers + schedulers |
| `mysql` | `mysql:8.0` | 3306 | `utf8mb4_0900_ai_ci`, volume `mysql-data` |
| `mysql-test` | `mysql:8.0` | 3307 | `tmpfs` storage → fast, wiped every run |
| `redis` | `redis:7-alpine` | 6379 | queues, rate limits, idempotency, socket adapter, counters |
| `mailpit` | `axllent/mailpit` | 8025 (UI), 1025 (SMTP) | see every email the system sends |
| `adminer` | `adminer` | 8080 | DB browser (dev only) |

Scripts: `npm run dev` (compose up + migrate + seed), `npm run db:migrate`, `npm run db:seed`, `npm run db:reset`, `npm test`, `npm run build`, `npm run lint`, `npm run openapi` (writes `openapi.json` the 3 frontends can generate a typed client from).

Environments: `.env` per environment validated at boot by Zod (the app refuses to start with a missing secret). Production compose adds nginx (TLS, `/uploads` static, gzip) and runs `prisma migrate deploy` on release.

**Seed data** = the current UI mock data (products, brands, categories, orders, customers, coupons, CMS pages…), ported once into `prisma/seed/data/*.ts`, so all three apps look the same on day one of switching to the API.

---

## 11. Testing strategy

| Level | Tool | What |
|---|---|---|
| Unit | Vitest | pure services: coupon rules engine, totals/tax calculator, segment rule compiler, points maths, ledger balancing, status transitions |
| API / integration | Vitest + Supertest + `mysql-test` | every endpoint: happy path, validation error, auth/permission (customer can't hit admin; `support` role can't refund) |
| Flow (e2e) | same | place order → webhook → points/ledger/stock; return → refund; drop reservation; concierge quote → payment; wallet top-up/withdraw; referral qualification |
| Concurrency | same | 20 parallel orders on the last 3 units → exactly 3 succeed; parallel wallet debits never go negative |
| Contract | `openapi.json` snapshot | breaking API change fails CI |
| Load (later) | k6 | product list, search, checkout |

Each test file resets the DB with `prisma migrate reset --skip-seed` + factories (`tests/setup/factories.ts`). Target ≥ 80% coverage on services.

---

## 12. Delivery phases

Each phase ends with: migrations, seed, OpenAPI docs, tests green, and **one app screen group switched from mock store to the API** so progress is visible.

| # | Phase | Modules | Unlocks |
|---|---|---|---|
| 0 | Foundation | project skeleton, Docker, config, error/validation/auth middleware, Prisma base, OpenAPI, logging, test harness, providers (mock payment, local storage, SMTP→Mailpit) | — |
| 1 | Identity | auth, customers (`/me`), admin-auth, team/RBAC, audit, settings (public), app-config | login on web, app and admin |
| 2 | Catalog | products, categories, brands, collections, size guides, search, media, inventory (read + reserve) | browsing screens on web and app; admin catalog |
| 3 | Shopping | carts, wishlist, addresses, coupons, shipping zones, pickups, tax, checkout, orders, payments (mock), wallet (spend) | full purchase flow end-to-end |
| 4 | After-sale | shipments, returns, refunds, ledger, transactions, payouts, draft orders, abandoned carts | admin ops screens; account orders/returns |
| 5 | Loyalty and money | club, rewards, referrals, wallet top-up/withdraw, saved payment methods | account rewards / wallet / referrals |
| 6 | Concierge | requests, quotes, concierge cart + checkout, chat (realtime), suppliers, drops/reservations | concierge on all apps |
| 7 | Support and notifications | tickets, feedback, customer notifications + push tokens, staff notification rules, activity feed | help centre, notification bell |
| 8 | Content and marketing | pages, FAQs, blog, SEO, banners, announcements, slots, segments, campaigns, messaging templates | CMS-driven storefront |
| 9 | Insights | analytics events + rollups, dashboard, analytics screens, reports | admin dashboard and analytics |
| 10 | Hardening | real payment provider adapter, S3 driver (if needed), rate-limit tuning, load test, backups, monitoring | production launch |

Frontend wiring (replacing each zustand mock store with API calls + React Query) is **separate work in each app**. It is listed per phase above so the backend is always proven against a real screen, but it is not included in "backend done".

---

## 13. Issues found in the UI that the backend has to settle

These are real inconsistencies in the current screens. The backend can only store **one** version, so each needs a decision (my recommendation in bold).

| # | Issue | Where | Recommendation |
|---|---|---|---|
| U1 | **Delivery fees disagree in four places.** Checkout says Lagos ₦4,000 / Abuja ₦5,000 / other ₦6,000. Shipping-policy page says ₦5,000 / ₦15,000 / ₦10,000. The trust badge says free shipping over ₦50,000. The announcement bar and the help article say free over ₦150,000. | checkout, customer-care shipping policy, order summary, announcement, help | **Shipping zones become the only source**; the policy page renders the rates from the API |
| U2 | **Customer tiers have three different naming schemes.** Club: Standard / Silver / Gold / Signature. Concierge requests: Guest / Member / Gold / Platinum. Account screen: "7,550 pts to **Platinum**". | club, concierge, account | **Standard / Silver / Gold / Signature** everywhere |
| U3 | **Return window differs.** Policy page: 7 days. Account returns: "3 – 7 days". Help: 14 days. | returns pages, help | **One setting** (`returns.windowDays`), shown everywhere from the API |
| U4 | **Concierge statuses have three different sets.** Admin: New → Delivered (8 states). Account requests: Sourcing / Order confirmed / In transit / Completed / Cancelled. Concierge cart: Sourcing in Progress / Payment Pending / Ready to Purchase. | concierge admin, account, concierge cart | Unified set from section 5.7, plus **label mappers per screen** |
| U5 | **Saving a card asks for the raw card number and CVV, and offers PayPal.** Card details must go to the payment provider, never through our server (PCI rules). PayPal isn't offered by Paystack or Flutterwave for NGN. | /account/payment-methods/new | **Card via the provider's hosted form**; drop PayPal or treat it as a later provider |
| U6 | The CMS (pages, FAQs, SEO) exists in admin, but the customer-care pages are hard-coded in `asl-web` and `asl-mobile`. | customer-care pages | Seed the current text into the CMS and **render pages from the API** (or keep them static and remove the admin pages) |
| U7 | **Admin screens that don't exist for things the API will hold:** feedback inbox, drop management, admin user profile. **Customer screens that don't exist for things admin manages:** blog. | — | Decide per item. The API endpoints are cheap to keep; screens are the real cost |
| U8 | **Two "delete account" behaviours.** The security page says "Contact support to delete your account"; the settings page actually deletes it. | account security / settings | **Self-service deletion** with a 30-day grace period |
| U9 | The concierge service fee (₦50,500) and shipping estimate (₦35,000) are hard-coded. | concierge cart | Store them in settings or per quote |
| U10 | Reward catalogues differ. The customer redeem screen has 6 fixed rewards; admin club rewards are a separate list with categories shipping / credit / experience / product / concierge. | rewards | **Admin club rewards drive the redeem screen** |
| U11 | Analytics screens show countries, devices and traffic sources that nothing in the apps records yet. | admin analytics | Add the `POST /events` tracking call to `asl-web` and `asl-mobile` (phase 9) |

### 13.1 Decisions still open

| # | Decision | Default if nobody decides |
|---|---|---|
| D1 | **Redis** isn't in your stack list. Queues, rate limits, realtime chat across instances and idempotency all need it. | Use Redis (one more container) |
| D2 | Payment provider | Mock now; Paystack adapter in phase 10 |
| D3 | Email / SMS providers | SMTP + mock SMS; Resend + Termii or Africa's Talking later |
| D4 | What happens to a drop **deposit** if the balance isn't paid? | Refund to wallet minus 10%? — needs a business answer |
| D5 | Guest checkout on or off? (The admin setting exists; the UI forces login.) | Off for now, API supports both |
| D6 | Multi-currency: display-only conversion, or charge in USD/GBP too? | Display-only, settle in NGN |
| D7 | One shared database for web, app and admin | Yes, one API and one DB |
| D8 | Hosting target (VPS with Docker, AWS, Render…) — affects the local-disk storage choice (R3) | Single VPS with Docker |

### 13.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Redis not approved → no queues | Fallback: MySQL-backed job table + `node-cron` (slower, single instance only) |
| R2 | Scope is large: ~60 modules in 12 domains, ~140 tables, roughly 400 endpoints | Phases above; every phase is shippable on its own |
| R3 | Local disk storage breaks with two API servers or containers that get rebuilt, and needs its own backups | Docker named volume + nightly backup; `StorageDriver` lets us switch to S3/R2 by changing one env var |
| R4 | Analytics on raw tables gets slow | Rollup tables from day one |
| R5 | Mock data in the UI assumes things are instant (e.g. payment "Order placed!"). Real payments are asynchronous. | `pending` states and a "verifying payment" screen in the apps |
| R6 | Money and stock race conditions | Row locks, idempotency keys, concurrency tests (section 11) |
