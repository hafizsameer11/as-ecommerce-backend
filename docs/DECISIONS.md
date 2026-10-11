# Decisions — one source of truth for rules the UIs disagreed on

The three UIs (asl-web, asl-mobile, asl-admin) hard-code several business values differently.
The backend now owns each of them. Every value below is **editable by an admin**, and the apps
must read it from `GET /api/v1/store/settings/public` instead of hard-coding it.

| # | Topic | What the UIs said | What the backend uses | Where to change it |
|---|---|---|---|---|
| U1 | Delivery fees | Checkout: Lagos ₦4,000 / Abuja ₦5,000 / other ₦6,000. Shipping-policy page: ₦5,000 / ₦15,000 / ₦10,000. Trust badge: free over ₦50,000. Announcement + help: free over ₦150,000 | **Lagos ₦4,000 (same day) · Abuja ₦5,000 (2–4 days) · Other states ₦6,000 (2–3 days) · International DHL from ₦45,000 (5–7 days) · free over ₦150,000** | Admin → Shipping zones; `shipping.freeShippingThreshold` |
| U2 | Customer tiers | Club: Standard/Silver/Gold/Signature. Concierge: Guest/Member/Gold/Platinum. Account: "pts to Platinum" | **Standard · Silver · Gold · Signature** | Admin → ASL Club (tier thresholds, multipliers, perks) |
| U3 | Return window | 7 days / "3 – 7 days" / 14 days | **7 days** | `returns.windowDays` |
| U4 | Concierge statuses | 3 different sets | One status list in the DB; each screen's wording comes from `labels.concierge.{admin,customer,cart}` | code: `status-labels.ts` |
| U8 | Delete account | Security page: "contact support". Settings page: deletes immediately | **Self-service delete** (type DELETE + password), personal data removed after 30 days | `account.deletionGraceDays` |
| U9 | Concierge fees | Hard-coded ₦50,500 service fee, ₦35,000 shipping estimate | Same values, now settings (and editable per quote) | `concierge.serviceFee`, `concierge.shippingEstimate` |
| — | Order status wording | Customer: Processing/Shipped/Delivered/Cancelled/Returned. Admin: Awaiting payment/Unfulfilled/… | One status list in the DB; wording from `labels.order.{customer,admin}` | `status-labels.ts` |
| — | Wallet limits | UI: top-up min ₦500, withdraw min ₦1,000 | Same, now settings | `wallet.minTopup`, `wallet.minWithdrawal` |

Delivery **times** were also inconsistent (checkout said "2 – 5 working days" everywhere). The backend
uses the per-zone times from the shipping-policy page. Change them in Shipping zones.

## Prototype data fixes applied in the seed (D-DATA)

The mock catalogue had a few data errors. They were fixed while importing. Check them in Admin → Products:

| Product | Problem | Fix |
|---|---|---|
| `fr5` "Bleu de Chanel Eau de Parfum" | Listed under brand DIOR | Brand → **CHANEL** |
| `tr3` "Relaxed Fit Cargo Pants" | Brand was "CARGO TROUSERS" (a product name) | Brand → **ASL ORIGINALS** — *please confirm* |
| `bs3`, `bs7` | Brand spelled "Nike", "Dior" | Merged into **NIKE**, **DIOR** |
| Essentials items | Both "ESSENTIALS" and "FEAR OF GOD ESSENTIALS" | Merged into **FEAR OF GOD ESSENTIALS** |
| Drops (coming soon) | Release dates were already in the past | Rescheduled into the coming weeks |
| Product ratings | Cards showed fixed numbers (e.g. 4.4 from 100 reviews) | Now calculated from real published reviews |
| Inventory | Some SKUs listed twice in the same warehouse | Merged |

## Open business decisions (defaults in place until decided)

| # | Question | Current default |
|---|---|---|
| D4 | Drop deposit when the balance is never paid | Not decided — reservation expires, deposit handling needs a policy |
| D5 | Guest checkout | Off (setting exists: `checkout.guestCheckout`) |
| D6 | Charge in foreign currencies? | No — display conversion only, settle in NGN |
| D2 | Payment provider | Mock provider (Paystack-shaped) until a provider is chosen |
