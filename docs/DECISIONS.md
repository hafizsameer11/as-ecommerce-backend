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

| — | Coupon codes | Checkout hard-coded ASL20OFF 20 %, WELCOME10 10 %, VIP30 30 %, APP10 10 % with no conditions. Admin list had different codes (VIP25, FREESHIP, SNEAKER15 …) and WELCOME10 = new members, min ₦50k, max ₦25k off | **One coupons table.** Admin codes as defined in admin; ASL20OFF (20 %, max ₦200k), APP10 (app only, once per customer) added; **VIP30 created paused** (VIP25 is the live VIP offer); WELCOME10 follows the admin rules | Admin → Coupons |
| — | Shipping-zone priority | Admin screen: lower number wins | Lower number wins (Lagos 1, Abuja 2, Other states 5, International 9) | Admin → Shipping zones |
| — | Tax | Admin: Nigeria VAT 7.5 %, inclusive | VAT 7.5 % included in prices — shown on the order, not added | Admin → Tax |

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

## Behaviour decided in code (tell me if any is wrong)

| Situation | What the backend does |
|---|---|
| Customer adds a multi-colour product without choosing a colour | Uses the first colour (same as the product page). Size is always required when the product has sizes |
| Unpaid order | Stock and coupon use are held for `checkout.unpaidOrderMinutes` (30), then the order is cancelled automatically (needs the worker + Redis running) |
| Payment arrives after that cancellation, or a customer pays twice | Refunded automatically to the original payment — the money is never kept silently |
| Customer cancels | Only while "Awaiting payment" or "Processing / unfulfilled". Full refund: wallet part back to wallet, card part back to the card. Stock goes back to the same warehouse |
| Card refunds and wallet withdrawals with the mock provider | Always succeed instantly. With a real provider some are asynchronous — webhook handling for refunds/transfers is still to do when the provider is chosen |
| Prices and stock at checkout | Recomputed on the server at "Place order". If the app sends `expectedTotal` and the total changed, the order is refused with the new totals |
| Cancelled / refunded order and loyalty points | Points don't exist yet (phase 5) |
| Return windows | 7 days from delivery for normal returns. "Damaged or defective" must be reported within 48 h with at least one photo. Fragrances, underwear, swimwear, personal care can't be returned for any reason (setting `returns.nonReturnableCategories`) — *confirm whether damaged fragrances should be accepted* |
| Customer cancels a return request | Stored as "Rejected" with a "you cancelled" note (there is no separate cancelled status) |
| Return refunds | Item price minus its share of the order discount; shipping is never refunded |
| Order delivered | Only when every shipment is delivered (or the pick-up is collected) |
| Pick-up orders | A pick-up slot is booked automatically for the next day at 12:00 when the order is paid; the store's daily capacity is respected |
| Deleting a customer (admin) | Personal data is wiped; orders, wallet history and invoices are kept. Refused while the wallet still holds money |
| Self-deleted accounts | Personal data removed automatically after `account.deletionGraceDays` (30) |
| Draft-order pay links | Valid 7 days; sending again makes the old link stop working. Orders from drafts have no delivery address yet (drafts have no address field) |
| Ledger | Sales, VAT, shipping, wallet, fees, refunds and payouts post automatically. Concierge, drop deposits and points are not journaled yet |

## Open business decisions (defaults in place until decided)

| # | Question | Current default |
|---|---|---|
| D4 | Drop deposit when the balance is never paid | Not decided — reservation expires, deposit handling needs a policy |
| D5 | Guest checkout | Off (setting exists: `checkout.guestCheckout`) |
| D6 | Charge in foreign currencies? | No — display conversion only, settle in NGN |
| D2 | Payment provider | Mock provider (Paystack-shaped) until a provider is chosen |
| D7 | FREESHIP (auto, all channels, ₦150k+) also makes **international** DHL delivery free | Kept as the admin mock defined it. Inside Nigeria delivery is already free above ₦150k, so today FREESHIP only changes international orders. Restrict it if that's not intended |
| D9 | Messages templates | Seeding never overwrites templates staff may have edited. Databases seeded before phase 4 keep older email texts until reset or edited in Admin → Messaging |
| D8 | Product weights | Not in the prototype data. International per-kg pricing assumes 1 kg per item until weights are entered (`weightGrams` on products) |
