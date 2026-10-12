/**
 * Domain events → staff alerts (NotificationRule). Concierge rules are fired by the concierge module;
 * `customer_ticket` by support/tickets.
 * `order_risk` and `system_backup` are seeded (the admin lists them) but nothing fires them yet:
 * there is no fraud engine and backups run outside the API.
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { ROLE_LABELS } from "@/core/auth/permissions";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { notifyStaff } from "./notification-settings.service";

let registered = false;

export function registerStaffAlertListeners() {
  if (registered) return;
  registered = true;

  events.on("order.paid", async ({ orderId }) => {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, number: true, total: true, channel: true, guestEmail: true, customer: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!o) return;
    const who = o.customer ? `${o.customer.firstName} ${o.customer.lastName}`.trim() || o.customer.email : (o.guestEmail ?? "Guest");
    const link = `/orders?id=${o.id}`;
    await notifyStaff("order_new", { title: `New order ${o.number}`, body: `${who} paid ${formatNaira(o.total)} (${o.channel}).`, link, entity: `order:${o.id}` });
    const { highValueThreshold } = await settingsService.get("orders");
    if (highValueThreshold > 0 && o.total >= highValueThreshold)
      await notifyStaff("order_high_value", {
        title: `High-value order ${o.number} · ${formatNaira(o.total)}`, body: `${who} placed an order above ${formatNaira(highValueThreshold)}.`, link, entity: `order:${o.id}`,
      });
  });

  // a return request is how customers ask for a refund from their account
  events.on("return.updated", async ({ returnId, status }) => {
    if (status !== "requested") return;
    const r = await prisma.returnRequest.findUnique({ where: { id: returnId }, select: { id: true, number: true, reason: true, order: { select: { number: true } } } });
    if (!r) return;
    await notifyStaff("order_refund", {
      title: `Return requested · ${r.number}`, body: `Order ${r.order.number}: ${r.reason}.`, link: `/returns?id=${r.id}`, entity: `return:${r.id}`, dedupeHours: 24,
    });
  });

  // stock.low fires on every movement below the reorder point → one alert per SKU per day
  events.on("stock.low", async ({ variantId, sku, available }) => {
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { product: { select: { name: true } } } });
    const name = v?.product.name ?? sku;
    const out = available <= 0;
    await notifyStaff(out ? "catalog_oos" : "catalog_low_stock", {
      title: out ? `Out of stock · ${sku}` : `Low stock · ${sku}`,
      body: out ? `${name} (${sku}) is sold out across all locations.` : `${name} (${sku}) is down to ${available} available.`,
      link: `/inventory?sku=${encodeURIComponent(sku)}`, entity: `sku:${sku}`, dedupeHours: 24,
    });
  });

  events.on("review.submitted", async ({ reviewId }) => {
    const r = await prisma.review.findUnique({ where: { id: reviewId }, select: { id: true, rating: true, title: true, authorName: true, product: { select: { name: true } } } });
    if (!r) return;
    await notifyStaff("catalog_review", {
      title: `Review pending · ${r.product.name}`, body: `${r.authorName} rated it ${r.rating}/5: "${r.title}"`, link: `/reviews?id=${r.id}`, entity: `review:${r.id}`,
    });
  });

  // payouts: one alert when the sync schedules a settlement, one when it is paid
  const payoutAlert = async (payoutId: string, paid: boolean) => {
    const p = await prisma.payout.findUnique({ where: { id: payoutId }, select: { id: true, number: true, provider: true, net: true, scheduledAt: true, bankName: true } });
    if (!p) return;
    await notifyStaff("finance_payout", {
      title: paid ? `Payout ${p.number} settled · ${formatNaira(p.net)}` : `Payout ${p.number} scheduled · ${formatNaira(p.net)}`,
      body: paid
        ? `${p.provider} settlement of ${formatNaira(p.net)} was paid to ${p.bankName}.`
        : `${p.provider} settlement of ${formatNaira(p.net)} is due ${p.scheduledAt.toISOString().slice(0, 10)} (${p.bankName}).`,
      link: `/payouts?id=${p.id}`, entity: `payout:${p.id}`,
    });
  };
  events.on("payout.pending", ({ payoutId }) => payoutAlert(payoutId, false));
  events.on("payout.paid", ({ payoutId }) => payoutAlert(payoutId, true));

  // VIP: reaching Signature (spend or set by staff) or being marked VIP — one alert per customer per day
  const vipAlert = async (customerId: string, why: string) => {
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, email: true, firstName: true, lastName: true } });
    if (!c) return;
    await notifyStaff("customer_vip", {
      title: `New VIP customer · ${fullName(c) || c.email}`, body: `${fullName(c) || c.email} (${c.email}) ${why}.`,
      link: `/customers?id=${c.id}`, entity: `customer:${c.id}`, dedupeHours: 24,
    });
  };
  events.on("club.tier_upgraded", async ({ customerId, to }) => {
    if (to === "Signature") await vipAlert(customerId, "reached the Signature tier");
  });
  events.on("customer.status_changed", async ({ customerId, to }) => {
    if (to === "vip") await vipAlert(customerId, "was marked VIP");
  });

  events.on("team.access_changed", async ({ kind, adminId, role, from, to, by }) => {
    const label = (r?: string) => (r && r in ROLE_LABELS ? ROLE_LABELS[r as keyof typeof ROLE_LABELS] : (r ?? ""));
    const who = adminId ? await prisma.adminUser.findUnique({ where: { id: adminId }, select: { name: true, email: true } }) : null;
    const actor = by ? ` by ${by}` : "";
    const n =
      kind === "role"
        ? { title: `Role changed · ${who?.name ?? "team member"}`, body: `${who?.name ?? "A team member"} (${who?.email ?? "?"}) moved from ${label(from)} to ${label(to)}${actor}.` }
        : kind === "status"
          ? { title: `Access ${to === "suspended" ? "suspended" : "restored"} · ${who?.name ?? "team member"}`, body: `${who?.name ?? "A team member"} (${who?.email ?? "?"}) is now ${to}${actor}.` }
          : { title: `Permissions changed · ${label(role)}`, body: `The ${label(role)} role's permissions were ${to === "defaults" ? "reset to the defaults" : "edited"}${actor}.` };
    await notifyStaff("system_role", { ...n, link: "/team", entity: adminId ? `admin:${adminId}` : `role:${role}` });
  });

  events.on("payment.failed", async ({ paymentId }) => {
    const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true, reference: true, amount: true, purpose: true, email: true, provider: true } });
    if (!p) return;
    await notifyStaff("finance_failed", {
      title: `Payment failed · ${p.reference}`, body: `${p.email}: ${formatNaira(p.amount)} (${p.purpose.replace(/_/g, " ")}, ${p.provider}).`,
      link: `/payments?reference=${encodeURIComponent(p.reference)}`, entity: `payment:${p.id}`,
    });
  });
}
