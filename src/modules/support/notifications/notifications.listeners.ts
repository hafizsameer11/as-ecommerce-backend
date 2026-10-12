/**
 * Domain events → customer inbox rows (/account/notifications).
 *
 * The existing listeners (orders, returns, concierge, club …) already send the e-mails / pushes for these
 * events, so these listeners ONLY write the inbox row (no channels) — nothing is sent twice.
 * Exception: wallet top-ups had no message at all, so they also push the `wallet.topup` template
 * (respecting the customer's preferences).
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { notify, type NotifyInput } from "./notifications.service";

let registered = false;

async function orderOf(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, customerId: true, total: true, cancelReason: true } });
}

const inboxOnly = (customerId: string, n: Omit<NotifyInput, "inbox" | "template" | "push">) => notify(customerId, n);

export function registerNotificationListeners() {
  if (registered) return;
  registered = true;

  events.on("order.paid", async ({ orderId }) => {
    const o = await orderOf(orderId);
    if (!o?.customerId) return;
    await inboxOnly(o.customerId, {
      category: "Orders", title: "Order Confirmed", icon: "Package",
      message: `Your order ${o.number} has been confirmed.`, ctaLabel: "View Order", ctaLink: `/account/orders/${o.number}`,
    });
  });

  events.on("order.shipped", async ({ orderId }) => {
    const o = await orderOf(orderId);
    if (!o?.customerId) return;
    await inboxOnly(o.customerId, {
      category: "Orders", title: "Order Shipped", icon: "Truck", topic: "shipping",
      message: `Good news! Your order ${o.number} has been shipped.`, ctaLabel: "Track Order", ctaLink: `/account/orders/${o.number}`,
    });
  });

  events.on("order.delivered", async ({ orderId }) => {
    const o = await orderOf(orderId);
    if (!o?.customerId) return;
    await inboxOnly(o.customerId, {
      category: "Orders", title: "Order Delivered", icon: "PackageCheck", topic: "shipping",
      message: `Your order ${o.number} has been delivered. Enjoy!`, ctaLabel: "View Order", ctaLink: `/account/orders/${o.number}`,
    });
  });

  events.on("order.cancelled", async ({ orderId }) => {
    const o = await orderOf(orderId);
    if (!o?.customerId) return;
    await inboxOnly(o.customerId, {
      category: "Orders", title: "Order Cancelled", icon: "XCircle",
      message: `Your order ${o.number} has been cancelled.${o.cancelReason ? ` ${o.cancelReason}` : ""}`, ctaLabel: "View Order", ctaLink: `/account/orders/${o.number}`,
    });
  });

  events.on("pickup.ready", async ({ bookingId }) => {
    const b = await prisma.pickupBooking.findUnique({ where: { id: bookingId }, select: { order: { select: { number: true, customerId: true } }, location: { select: { name: true } } } });
    if (!b?.order.customerId) return;
    await inboxOnly(b.order.customerId, {
      category: "Orders", title: "Ready for Pick-up", icon: "Store",
      message: `Your order ${b.order.number} is ready for collection at ${b.location.name}.`, ctaLabel: "View Order", ctaLink: `/account/orders/${b.order.number}`,
    });
  });

  events.on("return.updated", async ({ returnId }) => {
    const r = await prisma.returnRequest.findUnique({ where: { id: returnId }, select: { id: true, number: true, status: true, customerId: true } });
    if (!r?.customerId) return;
    const label = STATUS_LABELS.return.customer[r.status];
    await inboxOnly(r.customerId, {
      category: "Orders", title: "Return Update", icon: "RefreshCw",
      message: r.status === "requested" ? `We received your return request ${r.number}.` : `Your return request ${r.number} is now: ${label}.`,
      ctaLabel: "View Details", ctaLink: `/account/returns/${r.id}`,
    });
  });

  events.on("concierge.status_changed", async ({ requestId, to }) => {
    const r = await prisma.conciergeRequest.findUnique({ where: { id: requestId }, select: { number: true, customerId: true, itemName: true } });
    if (!r?.customerId) return;
    const label = (STATUS_LABELS.concierge.customer as Record<string, string>)[to] ?? to;
    await inboxOnly(r.customerId, {
      category: "Updates", tag: "CONCIERGE", title: "Concierge Update", icon: "Sparkles", topic: "concierge",
      message: `${r.itemName} (${r.number}): ${label}.`, ctaLabel: "View Request", ctaLink: `/account/requests/${r.number}`,
    });
  });

  events.on("concierge.quoted", async ({ quoteId }) => {
    const q = await prisma.conciergeQuote.findUnique({ where: { id: quoteId }, select: { number: true, total: true, request: { select: { number: true, customerId: true, itemName: true } } } });
    if (!q?.request.customerId) return;
    await inboxOnly(q.request.customerId, {
      category: "Updates", tag: "CONCIERGE", title: "Your Quote is Ready", icon: "Sparkles", topic: "concierge",
      message: `Quote ${q.number} for ${q.request.itemName}: ${formatNaira(q.total)}.`, ctaLabel: "View Quote", ctaLink: `/account/requests/${q.request.number}`,
    });
  });

  // wallet top-up: nothing else tells the customer, so this one also pushes (template wallet.topup)
  events.on("payment.succeeded", async ({ paymentId }) => {
    const p = await prisma.payment.findUnique({ where: { id: paymentId }, select: { purpose: true, customerId: true, amount: true } });
    if (p?.purpose !== "wallet_topup" || !p.customerId) return;
    const amount = formatNaira(p.amount);
    await notify(p.customerId, {
      category: "Account", title: "Wallet Topped Up", icon: "Wallet",
      message: `${amount} has been added to your wallet.`, ctaLabel: "View Wallet", ctaLink: "/account/wallet",
      template: { code: "wallet.topup", vars: { amount }, data: { type: "wallet" } }, channels: ["push"],
    });
  });

  // credits / reversals / withdrawals posted by staff or programmes (referral reward …)
  events.on("wallet.posted", async ({ txId }) => {
    const t = await prisma.walletTransaction.findUnique({ where: { id: txId }, select: { kind: true, status: true, amount: true, title: true, wallet: { select: { customerId: true } } } });
    if (!t || t.status !== "completed") return;
    const customerId = t.wallet.customerId;
    if (t.kind === "withdrawal")
      return void (await inboxOnly(customerId, {
        category: "Account", title: "Withdrawal Sent", icon: "Wallet",
        message: `${formatNaira(-t.amount)} is on its way to your bank account.`, ctaLabel: "View Wallet", ctaLink: "/account/wallet",
      }));
    if (t.amount > 0)
      await inboxOnly(customerId, {
        category: "Account", title: "Wallet Credited", icon: "Wallet",
        message: `${formatNaira(t.amount)} was added to your wallet (${t.title}).`, ctaLabel: "View Wallet", ctaLink: "/account/wallet",
      });
  });
}
