/**
 * Orders: one status model for both apps (labels come from status-labels.ts).
 * pending_payment → paid → processing → shipped → out_for_delivery → delivered,
 * side exits: cancelled, returned, refunded / partially_refunded.
 */
import crypto from "node:crypto";
import type { Order, OrderStatus, Payment, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { formatNaira } from "@/core/utils/money";
import { toCsv } from "@/core/utils/csv";
import { logger } from "@/core/utils/logger";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { couponsService } from "@/modules/commerce/coupons/coupons.service";
import { cartsService } from "@/modules/commerce/carts/carts.service";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";
import { listInclude, orderInclude, toAdminOrder, toAdminOrderRow, toCustomerOrder, toCustomerOrderCard, CUSTOMER_CANCELLABLE } from "./orders.mapper";
import type { AdminOrderQuery, RefundBody } from "./orders.schemas";

const STOCK_REF = (orderId: string) => ({ type: "order", id: orderId });

/** allowed manual moves in admin (cancel / refund have their own actions) */
const NEXT: Partial<Record<OrderStatus, OrderStatus[]>> = {
  paid: ["processing"],
  processing: ["shipped"],
  shipped: ["out_for_delivery", "delivered"],
  out_for_delivery: ["delivered"],
};

const EVENT_TITLE: Partial<Record<OrderStatus, string>> = {
  processing: "Preparing your order",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
};

export const newAccessToken = () => crypto.randomBytes(24).toString("base64url");

async function addEvent(db: Tx, orderId: string, type: string, title: string, o: { detail?: string; actor?: string; internal?: boolean } = {}) {
  await db.orderEvent.create({ data: { orderId, type, title, detail: o.detail, actor: o.actor, internal: o.internal ?? false } });
}

async function loadFull(where: Prisma.OrderWhereInput) {
  const o = await prisma.order.findFirst({ where, include: orderInclude });
  if (!o) throw ApiError.notFound("Order");
  return o;
}

/** inside a transaction: money for an order arrived (card, transfer, wallet) */
async function applyPayment(tx: Tx, orderId: string, amount: number, via: string, paymentId?: string) {
  await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.status === "cancelled" || o.amountPaid >= o.total) {
    // paid after we cancelled it (slow transfer) or paid twice (old payment link): never keep money we shouldn't
    const why = o.status === "cancelled" ? "Payment received after the order was cancelled" : "Duplicate payment";
    if (paymentId) await paymentsService.refund(tx, paymentId, amount, why, "system");
    else if (o.customerId) await walletsService.refund(tx, o.customerId, amount, `Refund for order ${o.number}`, { orderNumber: o.number });
    await addEvent(tx, o.id, "note", `${why} — refunded`, { detail: formatNaira(amount), internal: true });
    logger.warn({ order: o.number, amount, why }, "unexpected order payment refunded");
    return null;
  }
  const amountPaid = o.amountPaid + amount;
  const fullyPaid = amountPaid >= o.total;
  await tx.order.update({
    where: { id: o.id },
    data: {
      amountPaid,
      paymentStatus: fullyPaid ? "paid" : "partially_paid",
      ...(fullyPaid && o.status === "pending_payment" ? { status: "paid", paidAt: new Date() } : {}),
    },
  });
  if (!fullyPaid || o.status !== "pending_payment") return null;
  await addEvent(tx, o.id, "payment_confirmed", "Payment confirmed", { detail: via });
  await inventoryService.commitSale(tx, STOCK_REF(o.id));
  await couponsService.recordRevenue(tx, o.id, o.total);
  if (o.customerId) {
    const stats = await tx.customerStats.upsert({ where: { customerId: o.customerId }, create: { customerId: o.customerId }, update: {} });
    const ordersCount = stats.ordersCount + 1;
    const totalSpend = Number(stats.totalSpend) + o.total;
    await tx.customerStats.update({
      where: { customerId: o.customerId },
      data: { ordersCount, totalSpend: BigInt(totalSpend), spend12m: { increment: BigInt(o.total) }, aov: Math.round(totalSpend / ordersCount), lastOrderAt: new Date() },
    });
  }
  return o.id;
}

/** cancel + undo everything the order holds (stock, coupon uses, wallet spend, card payment) */
async function cancelInTx(tx: Tx, o: Order, reason: string, actor: string, refundTo: "original" | "wallet" = "original") {
  // unpaid → drop the reservation; paid → the sale already left the shelf, put it back
  await inventoryService.release(tx, STOCK_REF(o.id));
  await inventoryService.reverseSale(tx, STOCK_REF(o.id), actor);
  await couponsService.release(tx, o.id);
  let refunded = 0;
  if (o.walletApplied && o.customerId) {
    await walletsService.refund(tx, o.customerId, o.walletApplied, `Refund for order ${o.number}`, { orderNumber: o.number });
    refunded += o.walletApplied;
  }
  const paidByCard = o.amountPaid - o.walletApplied;
  if (paidByCard > 0) {
    if (refundTo === "wallet" && o.customerId) await walletsService.refund(tx, o.customerId, paidByCard, `Refund for order ${o.number}`, { orderNumber: o.number });
    else await refundPayments(tx, o.id, paidByCard, reason, actor);
    refunded += paidByCard;
  }
  await tx.payment.updateMany({ where: { orderId: o.id, status: "pending" }, data: { status: "abandoned" } });
  await tx.order.update({
    where: { id: o.id },
    data: {
      status: "cancelled", cancelReason: reason, cancelledAt: new Date(), amountRefunded: { increment: refunded },
      paymentStatus: refunded ? "refunded" : o.paymentStatus === "unpaid" ? "unpaid" : o.paymentStatus,
    },
  });
  await addEvent(tx, o.id, "cancelled", "Order cancelled", { detail: reason, actor });
  if (refunded) await addEvent(tx, o.id, "refunded", "Refund issued", { detail: formatNaira(refunded), actor });
}

/** refund card/bank payments, newest first */
async function refundPayments(tx: Tx, orderId: string, amount: number, reason: string, actor: string) {
  const pays = await tx.payment.findMany({ where: { orderId, status: { in: ["succeeded", "partially_refunded"] } }, orderBy: { paidAt: "desc" } });
  let left = amount;
  for (const p of pays) {
    if (left <= 0) break;
    const take = Math.min(left, p.amount - p.amountRefunded);
    if (take <= 0) continue;
    await paymentsService.refund(tx, p.id, take, reason, actor);
    left -= take;
  }
  if (left > 0) throw ApiError.badRequest("VALIDATION_FAILED", `Only ${formatNaira(amount - left)} can be refunded to the original payment.`);
}

export const ordersService = {
  STOCK_REF,
  addEvent,
  applyPayment,

  /** emitted after commit by callers that marked an order paid */
  afterPaid(orderId: string | null) {
    if (orderId) events.emit("order.paid", { orderId });
  },

  /**
   * inside a transaction: shipments / pick-up bookings move the order forward.
   * Never moves backwards, never touches unpaid / cancelled / refunded / returned orders.
   * Returns the change (caller emits events after commit) or null when nothing changed.
   */
  async syncFromFulfilment(tx: Tx, orderId: string, to: "processing" | "shipped" | "out_for_delivery" | "delivered", actor: string) {
    const FLOW: OrderStatus[] = ["paid", "processing", "shipped", "out_for_delivery", "delivered"];
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
    const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    const from = FLOW.indexOf(o.status);
    if (from < 0 || FLOW.indexOf(to) <= from) return null;
    await tx.order.update({ where: { id: orderId }, data: { status: to, ...(to === "delivered" ? { deliveredAt: new Date() } : {}) } });
    await addEvent(tx, orderId, to, EVENT_TITLE[to] ?? STATUS_LABELS.order.customer[to], { actor });
    return { from: o.status, to };
  },

  // ── customer ──
  async myOrders(customerId: string, q: { page: number; pageSize: number; status?: string }) {
    const map: Record<string, OrderStatus[]> = {
      Processing: ["pending_payment", "paid", "processing"],
      Shipped: ["shipped", "out_for_delivery"],
      Delivered: ["delivered", "partially_refunded"],
      Cancelled: ["cancelled"],
      Returned: ["returned", "refunded"],
    };
    const where: Prisma.OrderWhereInput = { customerId, ...(q.status && map[q.status] ? { status: { in: map[q.status] } } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { placedAt: "desc" }, ...paging(q), include: listInclude }),
      prisma.order.count({ where }),
      prisma.order.groupBy({ by: ["status"], where: { customerId }, _count: { _all: true } }),
    ]);
    const count = (s: OrderStatus[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const stats = {
      total: groups.reduce((n, g) => n + g._count._all, 0),
      inTransit: count(["shipped", "out_for_delivery"]),
      delivered: count(["delivered", "partially_refunded"]),
      returns: await prisma.returnRequest.count({ where: { customerId } }),
    };
    return withMeta(rows.map(toCustomerOrderCard), { ...pageMeta(q, total), stats });
  },

  async myOrder(customerId: string, idOrNumber: string) {
    const o = await loadFull({ customerId, OR: [{ id: idOrNumber }, { number: idOrNumber }] });
    const r = await settingsService.get("returns");
    return toCustomerOrder(o, { returnWindowDays: r.windowDays });
  },

  /** guest confirmation page / track-order (number + email) */
  async byAccessToken(token: string) {
    const o = await loadFull({ accessToken: token });
    const r = await settingsService.get("returns");
    return toCustomerOrder(o, { returnWindowDays: r.windowDays });
  },

  async lookup(number: string, email: string) {
    const o = await prisma.order.findFirst({
      where: { number: number.trim().toUpperCase(), OR: [{ guestEmail: email }, { customer: { email } }] },
      include: orderInclude,
    });
    // same message for "wrong number" and "wrong email" so order numbers can't be probed
    if (!o) throw ApiError.notFound("Order");
    const r = await settingsService.get("returns");
    return toCustomerOrder(o, { returnWindowDays: r.windowDays });
  },

  async cancelByCustomer(customerId: string, idOrNumber: string, reason?: string) {
    const o = await prisma.order.findFirst({ where: { customerId, OR: [{ id: idOrNumber }, { number: idOrNumber }] } });
    if (!o) throw ApiError.notFound("Order");
    if (!CUSTOMER_CANCELLABLE.includes(o.status))
      throw ApiError.conflict("INVALID_STATE", "This order is already being prepared and can't be cancelled. You can return it after delivery.");
    await prisma.$transaction((tx) => cancelInTx(tx, o, reason || "Cancelled by customer", "customer"));
    await paymentsService.flushRefunds(); // card refunds go to the gateway only after commit (outbox)
    events.emit("order.cancelled", { orderId: o.id });
    return this.myOrder(customerId, o.id);
  },

  /** pay the remaining balance (after a failed / abandoned payment) */
  async payAgain(where: Prisma.OrderWhereInput, input: { method: "card" | "bank_transfer"; savedMethodId?: string | null; returnUrl?: string | null }) {
    const o = await prisma.order.findFirst({ where });
    if (!o) throw ApiError.notFound("Order");
    const due = o.total - o.amountPaid;
    if (o.status !== "pending_payment" || due <= 0) throw ApiError.conflict("INVALID_STATE", "This order doesn't need a payment.");
    await prisma.payment.updateMany({ where: { orderId: o.id, status: "pending" }, data: { status: "abandoned" } });
    const email = (o.contact as { email: string }).email;
    return paymentsService.start({ purpose: "order", amount: due, email, customerId: o.customerId, orderId: o.id, method: input.method, savedMethodId: input.savedMethodId, returnUrl: input.returnUrl });
  },

  /** reorder: put the lines back in the bag */
  async reorder(customerId: string, idOrNumber: string) {
    const o = await prisma.order.findFirst({ where: { customerId, OR: [{ id: idOrNumber }, { number: idOrNumber }] }, include: { items: true } });
    if (!o) throw ApiError.notFound("Order");
    const lines = o.items.filter((i) => i.productId).map((i) => ({ productId: i.productId!, size: i.size, color: i.color, qty: i.qty }));
    return cartsService.addMany({ customerId }, lines);
  },

  // ── admin ──
  where(q: AdminOrderQuery): Prisma.OrderWhereInput {
    const tabs: Record<string, Prisma.OrderWhereInput> = {
      all: {},
      open: { status: { in: ["paid", "processing", "shipped", "out_for_delivery"] } },
      unfulfilled: { status: "paid" },
      awaiting_payment: { status: "pending_payment" },
      processing: { status: "processing" },
      shipped: { status: { in: ["shipped", "out_for_delivery"] } },
      delivered: { status: "delivered" },
      cancelled: { status: "cancelled" },
      returns: { status: { in: ["returned", "refunded", "partially_refunded"] } },
    };
    const and: Prisma.OrderWhereInput[] = [tabs[q.tab]];
    if (q.q)
      and.push({
        OR: [
          { number: { contains: q.q } }, { guestEmail: { contains: q.q } },
          { customer: { OR: [{ email: { contains: q.q } }, { firstName: { contains: q.q } }, { lastName: { contains: q.q } }, { phone: { contains: q.q } }] } },
        ],
      });
    if (q.channel) and.push({ channel: q.channel });
    if (q.paymentStatus) and.push({ paymentStatus: q.paymentStatus });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.from || q.to) and.push({ placedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } });
    return { AND: and };
  },

  async adminList(q: AdminOrderQuery) {
    const where = this.where(q);
    const sort: Prisma.OrderOrderByWithRelationInput =
      q.sort === "total" ? { total: "asc" } : q.sort === "-total" ? { total: "desc" } : q.sort === "placedAt" ? { placedAt: "asc" } : { placedAt: "desc" };
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [rows, total, groups, revenue] = await Promise.all([
      prisma.order.findMany({ where, ...paging(q), orderBy: sort, include: listInclude }),
      prisma.order.count({ where }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.order.aggregate({ where: { paidAt: { gte: since } }, _sum: { total: true }, _count: { _all: true } }),
    ]);
    const c = (s: OrderStatus[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const tabs = {
      all: groups.reduce((n, g) => n + g._count._all, 0), open: c(["paid", "processing", "shipped", "out_for_delivery"]), unfulfilled: c(["paid"]),
      awaiting_payment: c(["pending_payment"]), processing: c(["processing"]), shipped: c(["shipped", "out_for_delivery"]), delivered: c(["delivered"]),
      cancelled: c(["cancelled"]), returns: c(["returned", "refunded", "partially_refunded"]),
    };
    const paid30 = revenue._count._all;
    const kpis = { revenue30d: revenue._sum.total ?? 0, orders30d: paid30, aov30d: paid30 ? Math.round((revenue._sum.total ?? 0) / paid30) : 0, unfulfilled: tabs.unfulfilled };
    return withMeta(rows.map(toAdminOrderRow), { ...pageMeta(q, total), tabs, kpis, labels: STATUS_LABELS.order.admin });
  },

  async adminGet(id: string) {
    const o = await prisma.order.findFirst({
      where: { OR: [{ id }, { number: id }] },
      include: { ...orderInclude, notes: { orderBy: { createdAt: "desc" } }, customer: { select: { ...customerBrief, phone: true, tier: true } } },
    });
    if (!o) throw ApiError.notFound("Order");
    return toAdminOrder({ ...o, customer: o.customer ? { ...o.customer, name: fullName(o.customer) } : null });
  },

  async setStatus(id: string, to: OrderStatus, actor: string, note?: string) {
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) throw ApiError.notFound("Order");
    if (o.status === to) return this.adminGet(id);
    if (!NEXT[o.status]?.includes(to))
      throw ApiError.conflict("INVALID_STATE", `Can't move an order from "${STATUS_LABELS.order.admin[o.status]}" to "${STATUS_LABELS.order.admin[to]}".`);
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: { status: to, ...(to === "delivered" ? { deliveredAt: new Date() } : {}) } });
      await addEvent(tx, id, to, EVENT_TITLE[to] ?? STATUS_LABELS.order.customer[to], { detail: note, actor });
    });
    events.emit("order.status_changed", { orderId: id, from: o.status, to });
    // manual status changes notify the customer the same way shipment updates do
    if (to === "shipped") events.emit("order.shipped", { orderId: id, shipmentId: "" });
    if (to === "delivered") events.emit("order.delivered", { orderId: id });
    return this.adminGet(id);
  },

  async bulkStatus(ids: string[], to: OrderStatus, actor: string) {
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await this.setStatus(id, to, actor);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof ApiError ? e.message : "Failed" });
      }
    }
    return { updated: results.filter((r) => r.ok).length, results };
  },

  async adminCancel(id: string, b: { reason: string; refundTo: "original" | "wallet"; restock?: boolean }, actor: string) {
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) throw ApiError.notFound("Order");
    if (!["pending_payment", "paid", "processing"].includes(o.status))
      throw ApiError.conflict("INVALID_STATE", "Shipped orders can't be cancelled. Use a return instead.");
    await prisma.$transaction((tx) => cancelInTx(tx, o, b.reason, actor, b.refundTo));
    await paymentsService.flushRefunds();
    events.emit("order.cancelled", { orderId: id });
    return this.adminGet(id);
  },

  /** bank transfer confirmed by finance, or payment taken outside the gateway */
  async markPaid(id: string, b: { reference: string; method: string; note?: string }, actor: string) {
    const o = await prisma.order.findUnique({ where: { id } });
    if (!o) throw ApiError.notFound("Order");
    const due = o.total - o.amountPaid;
    if (o.status !== "pending_payment" || due <= 0) throw ApiError.conflict("INVALID_STATE", "This order has no balance to pay.");
    const paidId = await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({ where: { orderId: id, status: "pending" }, data: { status: "abandoned" } });
      await tx.payment.create({
        data: {
          reference: `MANUAL_${b.reference}`.slice(0, 190), provider: "manual", purpose: "order", method: b.method, status: "succeeded", amount: due,
          email: (o.contact as { email: string }).email, customerId: o.customerId, orderId: id, paidAt: new Date(), providerData: { note: b.note, by: actor },
        },
      });
      return applyPayment(tx, id, due, `${b.method} · confirmed by ${actor}`);
    });
    this.afterPaid(paidId);
    return this.adminGet(id);
  },

  async addNote(id: string, body: string, author: string) {
    await prisma.order.findUniqueOrThrow({ where: { id } });
    return prisma.orderNote.create({ data: { orderId: id, body, author } });
  },

  async removeNote(id: string, noteId: string) {
    await prisma.orderNote.deleteMany({ where: { id: noteId, orderId: id } });
    return { deleted: true };
  },

  /** "Refund order": money back to the card/bank or to the wallet, optional restock */
  /** `opts.inTx` runs inside the same transaction (returns use it to mark the RMA refunded atomically) */
  async refund(id: string, b: RefundBody, actor: string, opts: { inTx?: (tx: Tx) => Promise<void> } = {}) {
    let amount = 0;
    await prisma.$transaction(async (tx) => {
      // lock the order so two refunds can't both pass the "still refundable" check
      await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${id} FOR UPDATE`;
      const o = await tx.order.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw ApiError.notFound("Order");
      const refundable = o.amountPaid - o.amountRefunded;
      if (refundable <= 0) throw ApiError.conflict("INVALID_STATE", "Nothing left to refund on this order.");
      amount = b.amount ?? refundable;
      if (amount > refundable) throw ApiError.badRequest("VALIDATION_FAILED", `You can refund up to ${formatNaira(refundable)}.`);
      if (b.to === "wallet") {
        if (!o.customerId) throw ApiError.badRequest("VALIDATION_FAILED", "Guest orders can only be refunded to the original payment.");
        await walletsService.refund(tx, o.customerId, amount, `Refund for order ${o.number}`, { orderNumber: o.number });
      } else {
        // wallet-paid part goes back to the wallet, the rest to the card/bank
        const cardPart = Math.max(0, Math.min(amount, o.amountPaid - o.walletApplied - o.amountRefunded));
        if (cardPart) await refundPayments(tx, o.id, cardPart, b.reason, actor);
        if (amount - cardPart > 0 && o.customerId) await walletsService.refund(tx, o.customerId, amount - cardPart, `Refund for order ${o.number}`, { orderNumber: o.number });
      }
      if (b.restock && ["paid", "processing"].includes(o.status)) {
        await inventoryService.reverseSale(tx, STOCK_REF(o.id), actor);
      }
      const totalRefunded = o.amountRefunded + amount;
      const full = totalRefunded >= o.amountPaid;
      await tx.order.update({
        where: { id },
        data: { amountRefunded: totalRefunded, paymentStatus: full ? "refunded" : "partially_refunded", status: full ? "refunded" : o.status === "delivered" ? "partially_refunded" : o.status },
      });
      if (o.customerId) await tx.customerStats.updateMany({ where: { customerId: o.customerId }, data: { totalSpend: { decrement: BigInt(amount) } } });
      await addEvent(tx, id, "refunded", "Refund issued", { detail: `${formatNaira(amount)} to ${b.to === "wallet" ? "ASL Wallet" : "original payment"} — ${b.reason}`, actor });
      if (opts.inTx) await opts.inTx(tx);
    });
    if (b.to !== "wallet") await paymentsService.flushRefunds();
    events.emit("order.refunded", { orderId: id, amount });
    return this.adminGet(id);
  },

  async exportCsv(q: AdminOrderQuery) {
    const rows = await prisma.order.findMany({ where: this.where(q), orderBy: { placedAt: "desc" }, take: 50_000, include: listInclude });
    return toCsv(
      rows.map((o) => {
        const r = toAdminOrderRow(o);
        return { ...r, customerName: r.customer.name, customerEmail: r.customer.email, total: o.total / 100, amountPaid: o.amountPaid / 100 };
      }),
      ["number", "placedAt", "customerName", "customerEmail", "channel", "statusLabel", "paymentStatus", "paymentMethod", "deliveryMethod", "itemsCount", "total", "amountPaid", "tracking"],
      ["Order", "Placed", "Customer", "Email", "Channel", "Status", "Payment", "Method", "Delivery", "Items", "Total (NGN)", "Paid (NGN)", "Tracking"],
    );
  },

  /** job: cancel orders whose payment never completed, so their stock goes back on sale */
  async expireUnpaid() {
    const { unpaidOrderMinutes } = await settingsService.get("checkout");
    const cutoff = new Date(Date.now() - unpaidOrderMinutes * 60_000);
    const stale = await prisma.order.findMany({ where: { status: "pending_payment", placedAt: { lt: cutoff } }, take: 200 });
    let cancelled = 0;
    for (const o of stale) {
      // a payment may have succeeded at the gateway without the webhook arriving yet → check first
      const pending = await prisma.payment.findMany({ where: { orderId: o.id, status: "pending" } });
      for (const p of pending) await paymentsService.settle(p.reference).catch(() => undefined);
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      if (fresh.status !== "pending_payment") continue;
      await prisma.$transaction((tx) => cancelInTx(tx, fresh, "Payment was not completed in time", "system"));
      if (fresh.amountPaid > fresh.walletApplied) await paymentsService.flushRefunds();
      events.emit("order.cancelled", { orderId: o.id });
      cancelled++;
    }
    return { cancelled };
  },
};

export const expireUnpaidOrdersJob = defineJob("orders.expire-unpaid", async () => {
  await ordersService.expireUnpaid();
});

// card / transfer payments for orders
paymentsService.register("order", {
  async succeeded(tx, p: Payment) {
    const paid = await applyPayment(tx, p.orderId!, p.amount, `${p.method} · ${p.reference}`, p.id);
    return () => ordersService.afterPaid(paid);
  },
  async failed(tx, p: Payment) {
    await addEvent(tx, p.orderId!, "note", "Payment failed", { detail: p.reference, internal: true });
  },
});
