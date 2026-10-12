/**
 * Reference data the system needs to run (also loaded by tests).
 * Idempotent: safe to run on every deploy.
 *
 * Business values here are the single resolved versions of numbers the UIs disagreed on
 * (see docs/DECISIONS.md). They are all editable from the admin panel afterwards.
 */
import type { PrismaClient } from "../../src/generated/prisma/client";
import { DEFAULT_TEMPLATES } from "../../src/modules/marketing/messaging/templates.defaults";

const N = (naira: number) => naira * 100;

export async function seedReferenceData(prisma: PrismaClient) {
  // ── locales & currencies (admin /settings, customer /account/settings) ──
  const locales = [
    ["en", "English", true], ["fr", "Français", false], ["es", "Español", false], ["pt", "Português", false],
    ["yo", "Yoruba", false], ["ig", "Igbo", false], ["ha", "Hausa", false],
  ] as const;
  for (const [code, label, isDefault] of locales)
    await prisma.locale.upsert({ where: { code }, create: { code, label, isDefault, enabled: true }, update: {} });

  const currencies = [
    ["NGN", "NGN (₦)", 1, true], ["USD", "USD ($)", 1600, false], ["EUR", "EUR (€)", 1720, false],
    ["GBP", "GBP (£)", 2030, false], ["GHS", "GHS (₵)", 105, false], ["KES", "KES (KSh)", 12.4, false],
  ] as const;
  for (const [code, label, rate, isDefault] of currencies)
    await prisma.currency.upsert({ where: { code }, create: { code, label, rateX10000: Math.round(rate * 10000), isDefault }, update: {} });

  // ── payment methods (admin /settings → payments; checkout payment step) ──
  const methods = [
    ["paystack", "Card / Bank / USSD (Paystack)", "Paystack", true, "1.5% + ₦100"],
    ["flutterwave", "Flutterwave", "Flutterwave", false, "1.4%"],
    ["stripe", "Stripe (international cards)", "Stripe", false, "2.9% + 30¢"],
    ["wallet", "ASL Wallet", "Wallet", true, "Free"],
    ["bank_transfer", "Direct bank transfer", "Bank Transfer", true, "Free"],
    ["cod", "Cash on delivery", "Cash on Delivery", false, "Free"],
  ] as const;
  for (const [i, [id, label, provider, enabled, feeLabel]] of methods.entries())
    await prisma.paymentMethodSetting.upsert({ where: { id }, create: { id, label, provider, enabled, feeLabel, position: i }, update: {} });

  // ── ASL Club tiers (U2: Standard / Silver / Gold / Signature everywhere) ──
  const tiers = [
    ["Standard", "Standard", "#8a8a8a", 0, 100, ["Earn 1 point per ₦100", "Birthday reward", "Members-only offers"]],
    ["Silver", "Silver", "#b8b8b8", N(500_000), 110, ["1.1× points", "Free standard shipping on 2 orders / year", "Early sale access"]],
    ["Gold", "Gold", "#cc5000", N(2_000_000), 125, ["1.25× points", "Free express shipping", "Priority concierge", "Early drop access"]],
    ["Signature", "Signature", "#0f0f0f", N(7_500_000), 150, ["1.5× points", "Dedicated client advisor", "VIP preview events", "Complimentary gift wrapping"]],
  ] as const;
  for (const [i, [id, name, color, minSpend, mult, perks]] of tiers.entries())
    await prisma.clubTier.upsert({
      where: { id },
      create: { id, name, color, minSpend: BigInt(minSpend), multiplierX100: mult, perks: [...perks], position: i },
      update: {},
    });

  // ── ASL Club rewards (the customer /account/rewards/redeem list; value: credit = kobo, coupon = %) ──
  const allTiers = ["Standard", "Silver", "Gold", "Signature"];
  const rewards = [
    ["rw_credit_2500", "₦2,500 Store Credit", "Use on any purchase", 500, "credit", N(2_500), "ShoppingBag", allTiers],
    ["rw_free_shipping", "Free Standard Shipping", "On your next order", 800, "shipping", 100, "Truck", allTiers],
    ["rw_coupon_10", "10% Off Coupon", "One-time use, any category", 1200, "coupon", 10, "Percent", allTiers],
    ["rw_gift_box", "Signature Gift Box", "Curated ASL ORIGINALS gift", 2000, "product", null, "Gift", allTiers],
    ["rw_concierge_boost", "Concierge Priority Boost", "Skip the queue on next request", 3500, "concierge", null, "Sparkles", ["Silver", "Gold", "Signature"]],
    ["rw_vip_event", "VIP Preview Event Access", "Invitation to next launch event", 5000, "experience", null, "Coffee", ["Gold", "Signature"]],
  ] as const;
  for (const [i, [id, title, description, cost, category, value, icon, eligible]] of rewards.entries())
    await prisma.clubReward.upsert({
      where: { id },
      create: { id, title, description, cost, category, value, icon, eligibleTiers: [...eligible], position: i },
      update: {},
    });

  // ── shipping zones (U1: one delivery-fee table for checkout AND the shipping-policy page) ──
  if ((await prisma.shippingZone.count()) === 0) {
    const free = N(150_000);
    await prisma.shippingZone.create({
      data: {
        name: "Lagos", scope: "state", countries: ["NG"], regions: ["Lagos"], priority: 1,
        rates: { create: [{ name: "Lagos delivery", carrier: "InHouse", service: "Same day", baseFee: N(4_000), etaDays: "Same day delivery", freeAbove: free }] },
      },
    });
    await prisma.shippingZone.create({
      data: {
        name: "Abuja", scope: "state", countries: ["NG"], regions: ["FCT", "Abuja", "Federal Capital Territory"], priority: 2,
        rates: { create: [{ name: "Abuja delivery", carrier: "GIG", service: "Standard", baseFee: N(5_000), etaDays: "2 - 4 working days", freeAbove: free }] },
      },
    });
    await prisma.shippingZone.create({
      data: {
        name: "Other States", scope: "country", countries: ["NG"], regions: [], priority: 5,
        rates: { create: [{ name: "Nationwide delivery", carrier: "GIG", service: "Standard", baseFee: N(6_000), etaDays: "2 - 3 working days", freeAbove: free }] },
      },
    });
    await prisma.shippingZone.create({
      data: {
        name: "International", scope: "country", countries: ["*"], regions: [], priority: 9,
        rates: { create: [{ name: "International express", carrier: "DHL", service: "Express Worldwide", baseFee: N(45_000), perKgFee: N(8_000), etaDays: "5 - 7 working days" }] },
      },
    });
  }

  // ── default warehouse + pickup store ──
  await prisma.warehouse.upsert({ where: { code: "LOS-01" }, create: { name: "Lagos Main", code: "LOS-01", city: "Lagos", isDefault: true }, update: {} });
  if ((await prisma.pickupLocation.count()) === 0)
    await prisma.pickupLocation.create({
      data: {
        name: "ASL ORIGINALS Lekki", address: "The Lennox Mall, Admiralty Way, Lekki Phase 1", city: "Lagos", state: "Lagos",
        phone: "+234 810 123 4567", hours: "Mon - Sat: 10:00 AM - 9:00 PM · Sun: 12:00 PM - 7:00 PM", concierge: true,
      },
    });

  // ── chart of accounts (admin /ledger) ──
  const accounts = [
    ["1000", "Cash at bank", "asset"], ["1010", "Payment provider clearing", "asset"], ["1200", "Inventory", "asset"],
    ["2000", "Customer wallet balances", "liability"], ["2100", "VAT payable", "liability"], ["2200", "Customer deposits (reservations & concierge)", "liability"],
    ["2300", "Loyalty points liability", "liability"], ["3000", "Owner's equity", "equity"],
    ["4000", "Product sales", "revenue"], ["4100", "Shipping income", "revenue"], ["4200", "Concierge service fees", "revenue"],
    ["4900", "Discounts & refunds (contra revenue)", "revenue"], ["5000", "Cost of goods sold", "expense"], ["5100", "Payment processing fees", "expense"],
    ["5200", "Shipping costs", "expense"], ["5300", "Marketing & rewards", "expense"],
    ["4800", "Other income (forfeited deposits)", "revenue"],
  ] as const;
  for (const [code, name, type] of accounts)
    await prisma.ledgerAccount.upsert({ where: { code }, create: { code, name, type }, update: {} });

  // ── message templates (admin /messaging) ──
  for (const t of DEFAULT_TEMPLATES) {
    const vars = [...new Set([...(t.subject ?? "").matchAll(/\{\{(\w+)\}\}/g), ...t.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
    await prisma.messageTemplate.upsert({
      where: { code_channel: { code: t.code, channel: t.channel } },
      create: { code: t.code, name: t.name, channel: t.channel, category: t.category, trigger: t.trigger, subject: t.subject, body: t.body, ctaLabel: t.ctaLabel, linkTo: t.linkTo, variables: vars },
      update: {},
    });
  }

  // ── staff notification rules (admin /notification-settings) ──
  const rules = [
    ["order_new", "orders", "New order placed", "Fires when a customer completes checkout.", ["ops_manager", "super_admin"], "high"],
    ["order_high_value", "orders", "High-value order (> ₦2M)", "Alerts leadership for VIP purchases.", ["super_admin", "finance"], "critical"],
    ["order_refund", "orders", "Refund requested", "Customer initiated a refund from account.", ["support", "finance"], "high"],
    ["concierge_request", "concierge", "New concierge request", "New sourcing request submitted.", ["concierge_agent"], "high"],
    ["concierge_sla", "concierge", "SLA breach imminent", "Response or quote SLA about to expire.", ["concierge_agent", "ops_manager"], "critical"],
    ["concierge_quote", "concierge", "Quote approved by customer", "Client accepted a concierge quote.", ["concierge_agent"], "normal"],
    ["catalog_low_stock", "catalog", "Low stock threshold hit", "SKU dropped below reorder level.", ["catalog_manager", "ops_manager"], "normal"],
    ["catalog_oos", "catalog", "Out of stock", "SKU fully depleted across all locations.", ["catalog_manager"], "high"],
    ["catalog_review", "catalog", "Review pending moderation", "New review needs approval.", ["catalog_manager", "support"], "low"],
    ["customer_ticket", "customers", "Support ticket opened", "New customer support ticket.", ["support"], "high"],
    ["finance_failed", "finance", "Failed transaction", "Payment attempt failed after retry.", ["finance", "ops_manager"], "high"],
    ["system_login", "system", "Admin sign-in from new device", "Unrecognised device or IP.", ["super_admin"], "critical"],
    // fired by: payout.pending / payout.paid · Signature tier or status vip · team role / status / permission edits
    ["finance_payout", "finance", "Payout settled", "Provider confirmed a payout.", ["finance"], "normal"],
    ["customer_vip", "customers", "New VIP customer", "Customer crossed VIP lifetime value threshold.", ["marketing", "super_admin"], "normal"],
    ["system_role", "system", "Role or permission changed", "A team member's access was modified.", ["super_admin"], "high"],
    // seeded for the admin screen; nothing fires them yet (no fraud engine; backups run outside the API)
    ["order_risk", "orders", "Risk flag on order", "Fraud engine flagged a suspicious order.", ["ops_manager", "finance"], "critical"],
    ["system_backup", "system", "Daily backup summary", "Nightly backup and integrity report.", ["super_admin"], "low"],
  ] as const;
  for (const [id, category, label, description, recipients, priority] of rules)
    await prisma.notificationRule.upsert({
      where: { id },
      create: { id, category, label, description, recipients: [...recipients], priority, channels: { email: priority === "high" || priority === "critical", push: false, in_app: true, slack: false, sms: false } },
      update: {},
    });

  // ── abandoned-cart recovery (admin /carts → recovery rules) ──
  for (const [stage, delayMinutes] of [[1, 60], [2, 24 * 60]] as const)
    await prisma.recoveryRule.upsert({
      where: { stage },
      create: { stage, delayMinutes, channel: "email", templateCode: "cart.reminder" },
      update: {},
    });

  // ── tax (admin /tax): Nigerian VAT 7.5 %, already included in shelf prices ──
  if ((await prisma.taxRate.count()) === 0)
    await prisma.taxRate.create({ data: { name: "Nigeria VAT", scope: "country", region: "NG", rateBps: 750, basis: "inclusive", appliesTo: ["products", "shipping"], code: "NG-VAT" } });

  // ── coupons: the admin's list + the codes the checkout UI hard-coded (now one table) ──
  const day = 86_400_000;
  const at = (d: number) => new Date(Date.now() + d * day);
  const coupons = [
    { code: "WELCOME10", title: "Welcome 10% off", description: "First-order discount for new members.", type: "percent", value: 10, status: "active", startsAt: at(-30), endsAt: at(60), minSubtotal: N(50_000), maxDiscount: N(25_000), usageLimit: 2000, perCustomerLimit: 1, eligibility: "new", oncePerCustomer: true, channels: ["web", "mobile"], pinned: true },
    { code: "FREESHIP", title: "Free shipping over ₦150k", type: "free_shipping", value: 0, status: "active", startsAt: at(-14), minSubtotal: N(150_000), stackable: true, autoApply: true, channels: ["web", "mobile", "concierge"], pinned: true },
    { code: "VIP25", title: "Signature Members · 25% off", description: "Exclusive drop for Signature tier.", type: "percent", value: 25, status: "active", startsAt: at(-7), endsAt: at(21), maxDiscount: N(200_000), usageLimit: 500, perCustomerLimit: 3, eligibility: "vip", channels: ["web", "mobile"], notes: "Admin mock pointed at a 'signature-drop' collection that does not exist in the catalogue; applies to all products until that collection is created." },
    { code: "SNEAKER15", title: "Sneakers 15% off", type: "percent", value: 15, status: "active", startsAt: at(-3), endsAt: at(14), minSubtotal: N(100_000), appliesTo: "categories", appliesToRefs: ["sneakers-and-trainers"], channels: ["web", "mobile"] },
    { code: "LOEWE5K", title: "₦5,000 off Loewe", type: "fixed", value: N(5_000), status: "scheduled", startsAt: at(4), endsAt: at(30), minSubtotal: N(80_000), appliesTo: "brands", appliesToRefs: ["loewe"], oncePerCustomer: true, channels: ["web", "mobile"] },
    { code: "RAMADAN30", title: "Ramadan Edit · 30% off", type: "percent", value: 30, status: "expired", startsAt: at(-90), endsAt: at(-30), maxDiscount: N(150_000), appliesTo: "collections", appliesToRefs: ["ramadan"], channels: ["web", "mobile"] },
    { code: "BOGOFRAG", title: "Buy 1 Get 1 · Fragrances", type: "bogo", value: 100, status: "paused", startsAt: at(-20), endsAt: at(40), appliesTo: "categories", appliesToRefs: ["fragrances"], channels: ["web", "mobile"] },
    { code: "CONCIERGE10", title: "Concierge · 10% off deposit", type: "percent", value: 10, status: "active", startsAt: at(-10), maxDiscount: N(100_000), channels: ["concierge"] },
    { code: "DRAFT-SPRING", title: "Spring Preview (draft)", type: "percent", value: 20, status: "draft", startsAt: at(10), eligibility: "segment", segmentId: "returning-vip", oncePerCustomer: true, channels: ["web", "mobile"] },
    // previously hard-coded in the checkout screen
    { code: "ASL20OFF", title: "ASL 20% off", type: "percent", value: 20, status: "active", startsAt: at(-1), endsAt: at(90), maxDiscount: N(200_000), channels: ["web", "mobile"] },
    { code: "APP10", title: "App exclusive 10% off", description: "Only in the ASL ORIGINALS app.", type: "percent", value: 10, status: "active", startsAt: at(-1), oncePerCustomer: true, channels: ["mobile"] },
    { code: "VIP30", title: "VIP 30% off", type: "percent", value: 30, status: "paused", startsAt: at(-1), maxDiscount: N(300_000), eligibility: "vip", channels: ["web", "mobile"], notes: "Was hard-coded in checkout. Paused until marketing confirms it (VIP25 is the live VIP offer)." },
  ] as const;
  for (const c of coupons) {
    const { appliesToRefs, channels, ...rest } = c as typeof c & { appliesToRefs?: readonly string[] };
    await prisma.coupon.upsert({
      where: { code: c.code },
      create: { ...(rest as object), code: c.code, title: c.title, type: c.type, value: c.value, appliesToRefs: appliesToRefs ? [...appliesToRefs] : [], channels: [...channels] } as never,
      update: {},
    });
  }
}
