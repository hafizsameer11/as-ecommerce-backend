/**
 * Domain events → ActivityEntry rows (admin /activity feed + dashboard ticker).
 * Links are admin-app paths.
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { activityPruneJob, activityService as activity } from "./activity.service";

let registered = false;

async function orderBrief(orderId: string) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, number: true, total: true, amountPaid: true, channel: true, paymentMethod: true, guestEmail: true,
      customer: { select: { firstName: true, lastName: true, email: true } },
    },
  });
  if (!o) return null;
  const who = o.customer ? fullName(o.customer) || o.customer.email : (o.guestEmail ?? "Guest");
  return { ...o, who, link: `/orders/${o.id}` };
}

export function registerActivityListeners() {
  if (registered) return activityPruneJob;
  registered = true;

  events.on("order.placed", async ({ orderId }) => {
    const o = await orderBrief(orderId);
    if (o) await activity.record({ type: "order.placed", title: `Order ${o.number} placed`, meta: o.who, amount: o.total, link: o.link });
  });

  events.on("order.paid", async ({ orderId }) => {
    const o = await orderBrief(orderId);
    if (o)
      await activity.record({
        type: "order.paid", title: `Order ${o.number} paid`, meta: `${o.who} · ${o.paymentMethod.replace(/_/g, " ")}`, amount: o.amountPaid || o.total, link: o.link,
      });
  });

  events.on("order.shipped", async ({ orderId, shipmentId }) => {
    const o = await orderBrief(orderId);
    if (!o) return;
    const s = shipmentId ? await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { carrier: true, trackingNumber: true } }) : null;
    const meta = s ? [String(s.carrier).toUpperCase(), s.trackingNumber].filter(Boolean).join(" · ") : o.who;
    await activity.record({ type: "order.shipped", title: `Order ${o.number} shipped`, meta, link: o.link }, { dedupeHours: 1 });
  });

  events.on("order.cancelled", async ({ orderId }) => {
    const o = await orderBrief(orderId);
    if (o) await activity.record({ type: "order.cancelled", title: `Order ${o.number} cancelled`, meta: o.who, amount: o.total, link: o.link });
  });

  events.on("order.refunded", async ({ orderId, amount }) => {
    const o = await orderBrief(orderId);
    if (o) await activity.record({ type: "order.refunded", title: `Refund ${formatNaira(amount)} processed`, meta: `${o.number} · ${o.who}`, amount, link: o.link });
  });

  events.on("return.updated", async ({ returnId, status }) => {
    if (status !== "requested") return;
    const r = await prisma.returnRequest.findUnique({ where: { id: returnId }, select: { id: true, number: true, reason: true, order: { select: { number: true } } } });
    if (r) await activity.record({ type: "return.requested", title: `Return ${r.number} requested`, meta: `${r.order.number} · ${r.reason}`, link: `/returns?id=${r.id}` });
  });

  events.on("concierge.requested", async ({ requestId }) => {
    const r = await prisma.conciergeRequest.findUnique({ where: { id: requestId }, select: { id: true, number: true, itemName: true, brand: true, budget: true } });
    if (r)
      await activity.record({
        type: "concierge.requested", title: `New concierge request ${r.number}`, meta: [r.brand, r.itemName].filter(Boolean).join(" "), amount: r.budget, link: `/concierge/inbox?id=${r.id}`,
      });
  });

  events.on("concierge.quoted", async ({ quoteId }) => {
    const q = await prisma.conciergeQuote.findUnique({ where: { id: quoteId }, select: { number: true, total: true, request: { select: { id: true, number: true, itemName: true } } } });
    if (q)
      await activity.record({
        type: "concierge.quoted", title: `Request ${q.request.number} quoted`, meta: `${q.request.itemName} · ${q.number}`, amount: q.total, link: `/concierge/inbox?id=${q.request.id}`,
      });
  });

  // quote accepted (→ payment_pending) and deposit received (→ approved)
  events.on("concierge.status_changed", async ({ requestId, to }) => {
    if (to !== "payment_pending" && to !== "approved") return;
    const r = await prisma.conciergeRequest.findUnique({
      where: { id: requestId },
      select: { id: true, number: true, itemName: true, quotes: { orderBy: { createdAt: "desc" }, take: 1, select: { number: true, total: true } } },
    });
    if (!r) return;
    const q = r.quotes[0];
    await activity.record({
      type: "concierge.approved",
      title: to === "payment_pending" ? `Quote${q ? ` ${q.number}` : ""} accepted · ${r.number}` : `Request ${r.number} approved`,
      meta: r.itemName, amount: q?.total ?? null, link: `/concierge/inbox?id=${r.id}`,
    });
  });

  events.on("review.submitted", async ({ reviewId }) => {
    const r = await prisma.review.findUnique({ where: { id: reviewId }, select: { id: true, rating: true, status: true, product: { select: { name: true } } } });
    if (r)
      await activity.record({
        type: "review.submitted", title: `New ${r.rating}★ review · ${r.product.name}`, meta: r.status === "pending" ? "Awaiting moderation" : r.status, link: `/reviews?id=${r.id}`,
      });
  });

  events.on("stock.low", async ({ variantId, sku, available }) => {
    const v = await prisma.productVariant.findUnique({ where: { id: variantId }, select: { size: true, color: true, product: { select: { name: true } } } });
    const variant = v ? [v.color, v.size].filter(Boolean).join(" · ") : "";
    await activity.record(
      {
        type: "stock.low", title: `Low stock · ${v?.product.name ?? sku}${variant ? ` (${variant})` : ""}`,
        meta: `${Math.max(0, available)} left · ${sku}`, link: `/inventory?variant=${variantId}`,
      },
      { dedupeHours: 6 },
    );
  });

  events.on("coupon.minted", async ({ customerId, code }) => {
    const cc = await prisma.customerCoupon.findUnique({ where: { code }, select: { label: true, source: true } });
    await activity.record({ type: "coupon.minted", title: `Coupon ${code} minted`, meta: cc ? `${cc.label} · ${cc.source}` : undefined, link: `/customers?id=${customerId}` });
  });

  events.on("payout.paid", async ({ payoutId }) => {
    const p = await prisma.payout.findUnique({ where: { id: payoutId }, select: { id: true, number: true, provider: true, net: true, bankName: true } });
    if (p) await activity.record({ type: "payout.paid", title: `Payout ${p.number} paid`, meta: `${p.provider} settlement · ${p.bankName}`, amount: p.net, link: `/payouts?id=${p.id}` });
  });

  events.on("payout.pending", async ({ payoutId }) => {
    const p = await prisma.payout.findUnique({ where: { id: payoutId }, select: { id: true, number: true, provider: true, net: true, scheduledAt: true } });
    if (p)
      await activity.record({
        type: "payout.pending", title: `Payout ${p.number} scheduled`, meta: `${p.provider} settlement · due ${p.scheduledAt.toISOString().slice(0, 10)}`, amount: p.net, link: `/payouts?id=${p.id}`,
      });
  });

  events.on("catalog.updated", async ({ productId, action, status }) => {
    const p = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true, brand: { select: { name: true } } } });
    if (!p) return;
    const verb = action === "created" ? "added" : action === "updated" ? "updated" : status === "active" ? "published" : status === "deleted" ? "deleted" : `set to ${status}`;
    const title = `Product ${verb} · ${p.name}`;
    const link = `/products/${p.id}`;
    // repeated saves of the same product collapse into one "updated" row per 15 minutes
    if (action === "updated" && (await prisma.activityEntry.findFirst({ where: { type: "catalog.updated", link, title, createdAt: { gte: new Date(Date.now() - 15 * 60_000) } }, select: { id: true } })))
      return;
    await activity.record({ type: "catalog.updated", title, meta: p.brand.name, link });
  });

  events.on("club.tier_upgraded", async ({ customerId, from, to, reason }) => {
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { firstName: true, lastName: true, email: true } });
    if (!c) return;
    const who = fullName(c) || c.email;
    await activity.record({
      type: "customer.tier_upgraded", title: `${who} reached ${to}`, meta: `${from} → ${to}${reason === "admin" ? " · set by staff" : ""}`, link: `/customers?id=${customerId}`,
    });
    if (to === "Signature") await activity.record({ type: "customer.vip", title: `New VIP · ${who}`, meta: "Reached Signature tier", link: `/customers?id=${customerId}` }, { dedupeHours: 24 });
  });

  events.on("customer.status_changed", async ({ customerId, to }) => {
    if (to !== "vip") return;
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { firstName: true, lastName: true, email: true } });
    if (c) await activity.record({ type: "customer.vip", title: `New VIP · ${fullName(c) || c.email}`, meta: "Marked VIP by staff", link: `/customers?id=${customerId}` }, { dedupeHours: 24 });
  });

  events.on("ticket.created", async ({ ticketId }) => {
    const t = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true, number: true, subject: true, customerName: true } });
    if (t) await activity.record({ type: "ticket.created", title: `Ticket ${t.number} opened`, meta: `${t.customerName} · ${t.subject}`, link: `/tickets?id=${t.id}` });
  });

  return activityPruneJob;
}
