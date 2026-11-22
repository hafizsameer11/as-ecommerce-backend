# ASL POS backend — phased build

Same MySQL / Prisma DB and domain as the rest of ASL (orders, customers, inventory, club, wallet, pickups, concierge). **APIs are a separate surface:** `/api/v1/pos/*` (till) and later `/api/v1/admin/pos/*` (admin POS pages). Storefront (`/store`) and existing admin routes stay unchanged.

**Deferred forever until a later integration ticket:** SMS / WhatsApp / email / push *provider* wiring (Twilio, Meta, FCM, etc.). Every phase still **records** the outbound intent (or reuses messaging templates as `pending`) so providers can plug in later. Till actions themselves must work without providers.

Money remains **kobo** on the API (same as the rest of the backend).

---

## Phase 1 — Foundation + core sell (THIS PHASE)

**Goal:** A cashier can PIN-in, open a register, look up catalog/stock/customers, quote a basket, and complete an in-store sale (split tenders) that writes a real `Order` on channel `store`, moves stock, updates wallet/club.

| Deliverable | Notes |
|---|---|
| Surface `pos` | `/api/v1/pos/...`, auth = staff (AdminUser) JWT |
| Schema | `SalesChannel.store`, `DeliveryMethod.instore`, POS registers/sessions/cash moves, staff PIN + locationIds, order POS fields, warehouse↔pickup link |
| Permissions | `pos.sell`, `pos.discount`, `pos.price_override`, `pos.refund`, `pos.void`, `pos.cash_moves`, `pos.open_close`, `pos.stock_adjust`, `pos.reports`, `pos.manage` |
| Roles | `store_manager`, `store_supervisor`, `store_cashier` |
| Auth | `POST /pos/auth/pin`, session lock, `/pos/me` |
| Register session | Open with float, cash in/out, close + Z report |
| Catalog / stock | Search products + per-location stock for the till |
| Customers | Search + walk-in create |
| Quote + sale | Server pricing (VAT inclusive, coupon `store` channel, points, wallet); split pay; emit `order.paid` / `order.delivered` |
| Offline sync stub | `POST /pos/sales/sync` accepts batched completed sales (idempotent by client key) |

**Out of scope this phase:** returns UI depth, pickups, gift cards, promotions engine, reservations, alterations, transfers workflow, concierge-from-till, admin POS dashboard pages, messaging providers.

---

## Phase 2 — Returns + pickups + receipt queue ✅

- In-store returns / refunds (`GET/POST …/sales/:id/returnable|returns`) — cash / wallet / original; restock to boutique warehouse; approval over limit
- Pickup queue (`GET /pickups`, `POST …/ready`, `POST …/collect`) with 6-digit `pickupCode`
- Receipt send queues `PosOutboundMessage` as **pending** (no provider calls yet)
- `orders.refund` supports `to: "cash"` for till drawer refunds

---

## Phase 3 — Services & inventory depth

- Gift cards (issue, balance, redeem as tender) + ledger 2200
- Automatic promotions (bxgy / % / spend / birthday)
- Reservations (layaway deposit ≥50%, settle / cancel)
- Alterations tickets
- Ship-to-customer from till (uses shipping zones)
- Transfers: request → approve → in-transit → receive
- Stock counts + supplier GRN by scan
- Concierge request from till (`source` / location / staff)
- Sales credit / commission fields

---

## Phase 4 — Admin POS APIs + till wire-up

- `/api/v1/admin/pos/*`: overview, transactions, reports, registers, stock moves, audit, promotions, gift cards, POS settings
- Seed boutiques as warehouses linked to pickup locations
- Point `asl-originals-pos` prototype at real APIs (replace Zustand `useDb`)

---

## Phase 5 — Messaging providers (LATER)

- WhatsApp / SMS / email / push provider settings
- Template approval + send queue workers
- Wire Phase 2–3 `pending` outbounds to real providers

---

## Shared rules (locked)

- ASL Club (Standard → Signature) is the loyalty model
- VAT 7.5% **inclusive**
- Return window default 7 days (settings)
- Order numbers stay `ASL-ORD-…` one sequence
- Coupons need channel `store` to work at the till
- No fake-success: every till mutation hits DB or returns a real error
