/**
 * Domain events → staff alerts (NotificationRule). Concierge rules are fired by the concierge module;
 * `customer_ticket` by support/tickets.
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
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

  events.on("payment.failed", async ({ paymentId }) => {
    const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { id: true, reference: true, amount: true, purpose: true, email: true, provider: true } });
    if (!p) return;
    await notifyStaff("finance_failed", {
      title: `Payment failed · ${p.reference}`, body: `${p.email}: ${formatNaira(p.amount)} (${p.purpose.replace(/_/g, " ")}, ${p.provider}).`,
      link: `/payments?reference=${encodeURIComponent(p.reference)}`, entity: `payment:${p.id}`,
    });
  });
}
