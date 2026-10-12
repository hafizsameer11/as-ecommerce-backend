/**
 * Coming-soon drop reservations.
 *   reserve → pending_deposit (allocation held `drops.reservationHoldMinutes`) → deposit paid → reserved
 *   → drop goes live (job `drops.release` or admin) → stock held for each reservation, holders notified
 *   → pay-balance within `drops.balanceWindowHours` → a real paid Order (channel web) → balance_paid
 *   side exits: cancelled (customer before `cancelCutoffHours`, admin, unpaid deposit, drop ended)
 *               expired (balance not paid in time; deposit per `drops.depositRefundable`, D4)
 *
 * Stock: allocation is a promise, not stock. When the drop goes live one unit of the reserved
 * size is held per reservation (StockMovement ref "reservation"), retried on every release run until
 * stock is in, and again at pay-balance. Paying the balance moves the hold onto the order.
 * Pre-order products are made to order (no stock held), same as draft orders.
 */
import type { Payment, Prisma, Reservation } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { formatNaira } from "@/core/utils/money";
import { logger } from "@/core/utils/logger";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { taxService } from "@/modules/fulfilment/tax/tax.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { preferred } from "@/modules/support/notifications/notifications.service";
import { productInclude } from "@/modules/catalog/products/product.mapper";
import { pickVariant } from "@/modules/commerce/carts/carts.service";
import { ordersService, newAccessToken } from "@/modules/commerce/orders/orders.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { dropsLedger } from "./drops.ledger";
import {
  balanceDueBy, cancelBy, reservationInclude, reservationUrl, toAdminReservation, toCustomerReservation, type DropsSettings,
} from "./drops.mapper";
import type { AdminCancelReservationBody, AdminReservationsQuery, MyReservationsQuery, PayBalanceBody, ReserveBody } from "./drops.schemas";

const TARGET = "reservation";
const STOCK_REF = (id: string) => ({ type: "reservation", id });
const ACTIVE = ["pending_deposit", "reserved", "balance_paid"] as const;
const PAID_STATES = ["succeeded", "partially_refunded"] as const;
const HOLD_LAPSED = "Deposit was not paid in time";

type AfterCommit = () => void | Promise<void>;
type RefundTo = "wallet" | "original" | "none";

const dateText = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lagos" });
const dateTimeText = (d: Date) =>
  d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos" });

async function lockReservation(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`Reservation\` WHERE id = ${id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id } });
}

async function lockDrop(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`Drop\` WHERE id = ${id} FOR UPDATE`;
  return tx.drop.findUniqueOrThrow({ where: { id } });
}

/** unpaid reservations still holding a place in the allocation */
const livePending = (db: Tx | typeof prisma, dropId: string, excludeId?: string) =>
  db.reservation.count({ where: { dropId, status: "pending_deposit", holdExpiresAt: { gt: new Date() }, ...(excludeId ? { id: { not: excludeId } } : {}) } });

async function hasHold(db: Tx | typeof prisma, reservationId: string) {
  const [reserved, done] = await Promise.all([
    db.stockMovement.count({ where: { refType: TARGET, refId: reservationId, type: "reserve" } }),
    db.stockMovement.count({ where: { refType: TARGET, refId: reservationId, type: { in: ["release", "sale"] } } }),
  ]);
  return reserved > 0 && done === 0;
}

/** hold one unit of the reserved size; false when stock is short. Pre-order / variant-less products need nothing. */
async function tryHold(tx: Tx, r: Reservation, availability: string) {
  if (availability === "pre_order" || !r.variantId) return true;
  if (await hasHold(tx, r.id)) return true;
  try {
    await inventoryService.reserve(tx, [{ variantId: r.variantId, qty: 1 }], STOCK_REF(r.id));
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.code === "OUT_OF_STOCK") return false;
    throw e;
  }
}

const depositPayment = (db: Tx | typeof prisma, reservationId: string) =>
  db.payment.findFirst({ where: { targetType: TARGET, targetId: reservationId, purpose: "reservation_deposit", status: { in: [...PAID_STATES] } }, orderBy: { paidAt: "asc" } });

const abandonPending = (tx: Tx, reservationId: string, purpose?: "reservation_deposit" | "order_balance") =>
  tx.payment.updateMany({ where: { targetType: TARGET, targetId: reservationId, status: "pending", ...(purpose ? { purpose } : {}) }, data: { status: "abandoned" } });

async function loadMine(customerId: string, idOrNumber: string) {
  const r = await prisma.reservation.findFirst({ where: { customerId, OR: [{ id: idOrNumber }, { number: idOrNumber }] }, include: reservationInclude });
  if (!r) throw ApiError.notFound("Reservation");
  return r;
}

/** email (+ push) to the reservation holder; never fails the caller */
async function notify(reservationId: string, code: string, extra: Record<string, string> = {}, withPush = false) {
  try {
    const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: reservationInclude });
    if (!r) return;
    const s = await settingsService.get("drops");
    const vars = {
      firstName: r.customer.firstName || "there",
      reservationNumber: r.number,
      productName: `${r.drop.product.brand.name} ${r.drop.product.name}`,
      sizeText: r.size ? ` (size ${r.size})` : "",
      deposit: formatNaira(r.deposit),
      balance: formatNaira(r.balance),
      releaseDate: dateText(r.drop.releaseAt),
      dueBy: dateTimeText(balanceDueBy(r.drop.releaseAt, s)),
      reservationUrl: reservationUrl(r.number),
      depositPolicy: s.depositRefundable
        ? "If the balance isn't paid in time the reservation expires and your deposit is refunded."
        : "If the balance isn't paid in time the reservation expires and the deposit is kept.",
      ...extra,
    };
    await messaging.email(r.customer.email, code, vars);
    // e-mail is transactional (deposit / balance); push follows the customer's preferences (topic orders)
    if (withPush) await preferred.push(r.customerId, "orders", code, vars, { type: "reservation", reservationId: r.id, number: r.number });
  } catch (err) {
    logger.error({ err, reservationId, code }, "reservation notification failed");
  }
}

/**
 * Inside a transaction: give the deposit back (or keep it) and record the outcome.
 * Returns the after-commit journal.
 */
async function settleDeposit(tx: Tx, r: Reservation, to: RefundTo, reason: string, actor: string): Promise<{ after?: AfterCommit; text: string; outcome: string | null; refunded: number }> {
  if (!r.depositPaidAt) return { text: "", outcome: null, refunded: 0 };
  const pay = await depositPayment(tx, r.id);
  const provider = { provider: pay?.provider ?? "mock" };
  const amount = Math.min(r.deposit, pay ? pay.amount - pay.amountRefunded : r.deposit);
  if (to === "none" || amount <= 0) {
    return { after: () => dropsLedger.forfeited(r.number, r.deposit), text: "The deposit is non-refundable and has been kept.", outcome: "forfeited", refunded: 0 };
  }
  if (to === "wallet" || !pay) {
    await walletsService.refund(tx, r.customerId, amount, `Deposit refund · ${r.number}`, { reservationNumber: r.number });
    return {
      after: async () => {
        await dropsLedger.refunded(r.number, amount, "wallet", provider);
        events.emit("wallet.changed", { customerId: r.customerId });
      },
      text: `Your ${formatNaira(amount)} deposit is back in your ASL Wallet.`, outcome: "refunded_wallet", refunded: amount,
    };
  }
  await paymentsService.refund(tx, pay.id, amount, reason, actor);
  return {
    after: () => dropsLedger.refunded(r.number, amount, "original", provider),
    text: `Your ${formatNaira(amount)} deposit is being refunded to your original payment method.`, outcome: "refunded_original", refunded: amount,
  };
}

/** Inside a transaction: cancel (pending or reserved). Frees the allocation and any stock hold. */
async function cancelInTx(tx: Tx, r: Reservation, o: { reason: string; actor: string; refundTo: RefundTo }) {
  if (r.status !== "pending_deposit" && r.status !== "reserved")
    throw ApiError.conflict("INVALID_STATE", "Only reservations awaiting a deposit or balance can be cancelled.");
  await abandonPending(tx, r.id);
  let dep: Awaited<ReturnType<typeof settleDeposit>> = { text: "", outcome: null, refunded: 0 };
  if (r.status === "reserved") {
    await lockDrop(tx, r.dropId);
    await tx.drop.update({ where: { id: r.dropId }, data: { reservedCount: { decrement: 1 } } });
    await inventoryService.release(tx, STOCK_REF(r.id));
    dep = await settleDeposit(tx, r, o.refundTo, o.reason, o.actor);
  }
  await tx.reservation.update({
    where: { id: r.id },
    data: {
      status: "cancelled", cancelledAt: new Date(), cancelReason: o.reason, holdExpiresAt: null,
      depositRefunded: { increment: dep.refunded }, depositOutcome: dep.outcome,
    },
  });
  const notifyPaid = r.status === "reserved";
  return async () => {
    await dep.after?.();
    if (notifyPaid) await notify(r.id, "reservation.cancelled", { depositText: dep.text });
  };
}

/**
 * Inside the balance payment transaction: create the real order (mirrors draft-orders convertInTx):
 * one line (the reserved size), channel web, deposit + balance applied as payments, stock moved from
 * the reservation hold onto the order, then committed as a sale by applyPayment.
 */
async function convertInTx(tx: Tx, r: Reservation, balancePayment: Payment | null) {
  const drop = await tx.drop.findUniqueOrThrow({ where: { id: r.dropId }, include: { product: { include: productInclude } } });
  const p = drop.product;
  const v = r.variantId ? p.variants.find((x) => x.id === r.variantId) : null;
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: r.customerId }, select: { email: true, phone: true, firstName: true, lastName: true } });
  const tax = await taxService.compute({ country: "NG", productsAmount: r.price, shippingAmount: 0, customerEmail: customer.email });
  const deposit = await depositPayment(tx, r.id);

  const number = formatters.order(await nextSequence(tx, "order", 10249));
  const order = await tx.order.create({
    data: {
      number,
      customerId: r.customerId,
      accessToken: newAccessToken(),
      channel: "web",
      deliveryMethod: "ship",
      paymentMethod: balancePayment?.method === "bank_transfer" ? "bank_transfer" : "card",
      subtotal: r.price, discount: 0, shipping: 0,
      // the reserved price is all-in: VAT is reported inside it, delivery is included
      tax: 0, taxIncluded: tax.included + tax.added,
      total: r.price,
      contact: { email: customer.email, phone: customer.phone ?? "", name: fullName(customer) },
      shippingAddress: (r.shippingAddress as Prisma.InputJsonValue | null) ?? undefined,
      shippingRateName: "Included with your reservation",
      items: {
        create: [{
          productId: p.id, variantId: v?.id ?? null, sku: v?.sku ?? null, name: p.name, brand: p.brand.name,
          imageUrl: p.images.find((img) => img.color && img.color === r.color)?.url ?? p.images[0]?.url ?? null,
          size: r.size, color: r.color, qty: 1, unitPrice: r.price, lineTotal: r.price,
        }],
      },
    },
  });
  await ordersService.addEvent(tx, order.id, "placed", "Order placed", {
    detail: `From reservation ${r.number} · deposit ${formatNaira(r.deposit)} + balance ${formatNaira(r.balance)}`, actor: "customer",
  });

  // stock: the reservation's hold becomes the order's (same transaction, rows stay locked)
  await inventoryService.release(tx, STOCK_REF(r.id));
  if (p.availability !== "pre_order" && v) {
    try {
      await inventoryService.reserve(tx, [{ variantId: v.id, qty: 1 }], ordersService.STOCK_REF(order.id));
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "OUT_OF_STOCK") throw e;
      // already paid in full: keep the order, flag it for the team
      await ordersService.addEvent(tx, order.id, "note", "Stock short for a reservation order", { detail: `Check inventory: ${v.sku}`, internal: true });
      logger.warn({ order: number, reservation: r.number }, "reservation converted with stock short");
    }
  }

  await tx.payment.updateMany({ where: { targetType: TARGET, targetId: r.id, status: { in: [...PAID_STATES] } }, data: { orderId: order.id } });
  let paid: string | null = null;
  if (r.deposit > 0) paid = await ordersService.applyPayment(tx, order.id, r.deposit, `Deposit · ${r.number}`, deposit?.id);
  if (balancePayment) paid = (await ordersService.applyPayment(tx, order.id, balancePayment.amount, `${balancePayment.method} · ${balancePayment.reference}`, balancePayment.id)) ?? paid;
  await tx.reservation.update({ where: { id: r.id }, data: { status: "balance_paid", balancePaidAt: new Date(), orderId: order.id } });

  return {
    order,
    after: async () => {
      events.emit("order.placed", { orderId: order.id });
      ordersService.afterPaid(paid);
      await dropsLedger.applied(r.number, r.deposit, order.number, { provider: deposit?.provider ?? "mock" });
    },
  };
}

/** Inside a transaction: the balance window closed. */
async function expireInTx(tx: Tx, r: Reservation, s: DropsSettings) {
  await abandonPending(tx, r.id);
  await lockDrop(tx, r.dropId);
  await tx.drop.update({ where: { id: r.dropId }, data: { reservedCount: { decrement: 1 } } });
  await inventoryService.release(tx, STOCK_REF(r.id));
  const dep = await settleDeposit(tx, r, s.depositRefundable ? "original" : "none", "Drop balance not paid in time", "system");
  await tx.reservation.update({
    where: { id: r.id },
    data: { status: "expired", expiredAt: new Date(), depositRefunded: { increment: dep.refunded }, depositOutcome: dep.outcome },
  });
  return async () => {
    await dep.after?.();
    await notify(r.id, "reservation.expired", { depositText: dep.text });
  };
}

async function run(fn: (tx: Tx) => Promise<AfterCommit | void>) {
  const after = await prisma.$transaction(fn);
  if (after) await after();
}

export const reservationsService = {
  STOCK_REF,

  // ── customer ──
  async reserve(customerId: string, dropIdOrHandle: string, b: ReserveBody) {
    const drop = await prisma.drop.findFirst({
      where: { OR: [{ id: dropIdOrHandle }, { product: { handle: dropIdOrHandle } }] },
      include: { product: { include: productInclude } },
    });
    if (!drop) throw ApiError.notFound("Drop");
    const p = drop.product;
    if (drop.status !== "upcoming" || drop.releaseAt <= new Date() || p.status !== "active" || p.deletedAt)
      throw ApiError.badRequest("DROP_NOT_OPEN", "Reservations are closed for this drop.");
    const coloured = p.variants.some((v) => v.color);
    const color = coloured ? (b.color ?? p.colors[0]?.name ?? null) : null;
    const v = p.variants.length ? pickVariant(p, b.size ?? null, color) : null;
    const price = v?.price ?? p.price;
    const deposit = Math.round((price * drop.depositPct) / 100);
    const s = await settingsService.get("drops");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });

    const r = await prisma.$transaction(async (tx) => {
      const d = await lockDrop(tx, drop.id);
      const now = new Date();
      if (d.status !== "upcoming" || d.releaseAt <= now) throw ApiError.badRequest("DROP_NOT_OPEN", "Reservations are closed for this drop.");
      const active = await tx.reservation.findFirst({ where: { dropId: d.id, customerId, status: { in: [...ACTIVE] } } });
      if (active && active.status !== "pending_deposit")
        throw ApiError.conflict("ALREADY_RESERVED", "You already have a reservation for this drop.", { reservation: active.number });
      const full = async (exclude?: string) => d.reservedCount + (await livePending(tx, d.id, exclude)) >= d.allocation;
      const data = {
        size: v?.size ?? null, color: v?.color ?? color, variantId: v?.id ?? null, price, deposit, balance: price - deposit,
        holdExpiresAt: new Date(now.getTime() + s.reservationHoldMinutes * 60_000),
      };
      if (active) {
        // trying the deposit again (failed / closed payment page): same reservation, fresh payment
        await abandonPending(tx, active.id, "reservation_deposit");
        const lapsed = !active.holdExpiresAt || active.holdExpiresAt <= now;
        if (lapsed && (await full(active.id))) throw ApiError.conflict("OUT_OF_STOCK", "This drop is fully reserved.", { allocation: d.allocation });
        return tx.reservation.update({ where: { id: active.id }, data });
      }
      if (await full()) throw ApiError.conflict("OUT_OF_STOCK", "This drop is fully reserved.", { allocation: d.allocation });
      const number = formatters.reservation(await nextSequence(tx, "reservation", 1001));
      return tx.reservation.create({ data: { ...data, number, dropId: d.id, customerId } });
    });

    const payment = await paymentsService.start({
      purpose: "reservation_deposit", amount: r.deposit, email: customer.email, customerId, targetType: TARGET, targetId: r.id,
      method: b.method, savedMethodId: b.savedMethodId, returnUrl: b.returnUrl,
    });
    return { reservation: await this.mine(customerId, r.id), payment };
  },

  async listMine(customerId: string, q: MyReservationsQuery) {
    const tabs = {
      all: {},
      active: { status: { in: ["pending_deposit", "reserved"] } },
      past: { status: { in: ["balance_paid", "cancelled", "expired"] } },
    } satisfies Record<MyReservationsQuery["tab"], Prisma.ReservationWhereInput>;
    const where: Prisma.ReservationWhereInput = { customerId, ...tabs[q.tab] };
    const [rows, total, groups, s] = await Promise.all([
      prisma.reservation.findMany({ where, include: reservationInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.reservation.count({ where }),
      prisma.reservation.groupBy({ by: ["status"], where: { customerId }, _count: { _all: true } }),
      settingsService.get("drops"),
    ]);
    const c = (st?: string[]) => groups.filter((g) => !st || st.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    return withMeta(rows.map((r) => toCustomerReservation(r, s)), {
      ...pageMeta(q, total),
      tabs: { all: c(), active: c(["pending_deposit", "reserved"]), past: c(["balance_paid", "cancelled", "expired"]) },
    });
  },

  async mine(customerId: string, idOrNumber: string) {
    const [r, s] = await Promise.all([loadMine(customerId, idOrNumber), settingsService.get("drops")]);
    return toCustomerReservation(r, s);
  },

  /** the customer's current reservation for a drop (drop page "already reserved") */
  async activeFor(customerId: string, dropId: string) {
    const r = await prisma.reservation.findFirst({ where: { customerId, dropId, status: { in: [...ACTIVE] } }, include: reservationInclude });
    return r ? toCustomerReservation(r, await settingsService.get("drops")) : null;
  },

  /** before release (and `cancelCutoffHours`): deposit back per `drops.cancelRefundTo` */
  async cancelMine(customerId: string, idOrNumber: string, reason?: string) {
    const found = await loadMine(customerId, idOrNumber);
    const s = await settingsService.get("drops");
    await run(async (tx) => {
      const r = await lockReservation(tx, found.id);
      if (!r) throw ApiError.notFound("Reservation");
      if (r.status === "reserved") {
        const d = await tx.drop.findUniqueOrThrow({ where: { id: r.dropId } });
        if (d.status !== "upcoming" || new Date() >= cancelBy(d.releaseAt, s))
          throw ApiError.conflict("INVALID_STATE", `Reservations can be cancelled up to ${s.cancelCutoffHours} hours before the drop.`);
      }
      return cancelInTx(tx, r, { reason: reason || "Cancelled by customer", actor: "customer", refundTo: s.cancelRefundTo });
    });
    return this.mine(customerId, found.id);
  },

  async payBalance(customerId: string, idOrNumber: string, b: PayBalanceBody) {
    const r = await loadMine(customerId, idOrNumber);
    const s = await settingsService.get("drops");
    if (r.status !== "reserved") throw ApiError.conflict("INVALID_STATE", "There is no balance to pay on this reservation.");
    if (r.drop.status !== "live" && r.drop.status !== "sold_out") throw ApiError.badRequest("DROP_NOT_OPEN", "The balance can be paid once the piece drops.");
    if (new Date() > balanceDueBy(r.drop.releaseAt, s)) throw ApiError.conflict("INVALID_STATE", "The time to pay the balance has passed.");

    const a = b.addressId
      ? await prisma.address.findFirst({ where: { id: b.addressId, customerId } })
      : await prisma.address.findFirst({ where: { customerId, type: "shipping" }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
    if (b.addressId && !a) throw ApiError.notFound("Address");
    const address = a
      ? { fullName: a.recipient, address: a.line1, apartment: a.line2 ?? "", city: a.city, state: a.state, postal: a.postalCode ?? "", country: a.country, phone: a.phone }
      : undefined;

    const converted = await prisma.$transaction(async (tx) => {
      const locked = await lockReservation(tx, r.id);
      if (!locked || locked.status !== "reserved") throw ApiError.conflict("INVALID_STATE", "There is no balance to pay on this reservation.");
      // make sure the piece is ours while the customer pays
      if (!(await tryHold(tx, locked, r.drop.product.availability)))
        throw ApiError.conflict("OUT_OF_STOCK", "We couldn't secure your size yet. Please try again shortly or contact support.");
      await abandonPending(tx, r.id, "order_balance");
      const updated = await tx.reservation.update({ where: { id: r.id }, data: { shippingAddress: address ?? undefined } });
      // 100 % deposit: nothing left to pay → order right away
      return updated.balance <= 0 ? convertInTx(tx, updated, null) : null;
    });
    if (converted) {
      await converted.after();
      return { reservation: await this.mine(customerId, r.id), payment: null };
    }
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
    const payment = await paymentsService.start({
      purpose: "order_balance", amount: r.balance, email: customer.email, customerId, targetType: TARGET, targetId: r.id,
      method: b.method, savedMethodId: b.savedMethodId, returnUrl: b.returnUrl,
    });
    return { reservation: await this.mine(customerId, r.id), payment };
  },

  // ── admin ──
  async adminList(dropIdOrHandle: string, q: AdminReservationsQuery) {
    const drop = await prisma.drop.findFirst({ where: { OR: [{ id: dropIdOrHandle }, { product: { handle: dropIdOrHandle } }] }, select: { id: true } });
    if (!drop) throw ApiError.notFound("Drop");
    const and: Prisma.ReservationWhereInput[] = [{ dropId: drop.id }];
    if (q.tab !== "all") and.push({ status: q.tab });
    if (q.q)
      and.push({
        OR: [{ number: { contains: q.q } }, { customer: { email: { contains: q.q } } }, { customer: { firstName: { contains: q.q } } }, { customer: { lastName: { contains: q.q } } }],
      });
    const where = { AND: and };
    const [rows, total, groups, s] = await Promise.all([
      prisma.reservation.findMany({ where, include: reservationInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.reservation.count({ where }),
      prisma.reservation.groupBy({ by: ["status"], where: { dropId: drop.id }, _count: { _all: true } }),
      settingsService.get("drops"),
    ]);
    const c = (st?: string) => groups.filter((g) => !st || g.status === st).reduce((n, g) => n + g._count._all, 0);
    return withMeta(rows.map((r) => toAdminReservation(r, s)), {
      ...pageMeta(q, total),
      tabs: { all: c(), pending_deposit: c("pending_deposit"), reserved: c("reserved"), balance_paid: c("balance_paid"), cancelled: c("cancelled"), expired: c("expired") },
    });
  },

  async adminGet(dropIdOrHandle: string, rid: string) {
    const r = await prisma.reservation.findFirst({
      where: { OR: [{ id: rid }, { number: rid }], drop: { OR: [{ id: dropIdOrHandle }, { product: { handle: dropIdOrHandle } }] } },
      include: reservationInclude,
    });
    if (!r) throw ApiError.notFound("Reservation");
    return toAdminReservation(r, await settingsService.get("drops"));
  },

  async adminCancel(dropIdOrHandle: string, rid: string, b: AdminCancelReservationBody, actor: string) {
    const before = await this.adminGet(dropIdOrHandle, rid);
    await run(async (tx) => {
      const r = await lockReservation(tx, before.id);
      if (!r) throw ApiError.notFound("Reservation");
      return cancelInTx(tx, r, { reason: b.reason, actor, refundTo: b.refundTo });
    });
    return { before, after: await this.adminGet(dropIdOrHandle, before.id) };
  },

  // ── release / expiry (jobs + admin) ──
  /** upcoming → live: hold stock for every paid reservation and tell the holders. */
  async markLive(dropId: string, actor: string) {
    const holders: string[] = [];
    let short = 0;
    await prisma.$transaction(async (tx) => {
      const d = await lockDrop(tx, dropId);
      if (d.status !== "upcoming") throw ApiError.conflict("INVALID_STATE", "Only upcoming drops can go live.");
      const now = new Date();
      // released early by staff → the balance window starts now
      await tx.drop.update({ where: { id: d.id }, data: { status: "live", releaseAt: d.releaseAt < now ? d.releaseAt : now } });
      const p = await tx.product.findUniqueOrThrow({ where: { id: d.productId }, select: { availability: true } });
      const rows = await tx.reservation.findMany({ where: { dropId: d.id, status: "reserved" }, orderBy: { depositPaidAt: "asc" } });
      for (const r of rows) {
        if (!(await tryHold(tx, r, p.availability))) short++;
        holders.push(r.id);
      }
    });
    if (short) logger.warn({ dropId, short, actor }, "drop released with stock short for some reservations");
    for (const id of holders) await notify(id, "drop.live", {}, true);
    await this.syncStatus(dropId);
    return { notified: holders.length, stockShort: short };
  },

  /** live ↔ sold_out from stock; retry holds for reservations still waiting for stock */
  async syncStatus(dropId: string) {
    await prisma.$transaction(async (tx) => {
      const d = await lockDrop(tx, dropId);
      if (d.status !== "live" && d.status !== "sold_out") return;
      const p = await tx.product.findUniqueOrThrow({ where: { id: d.productId }, select: { availability: true, variants: { select: { stock: { select: { onHand: true, reserved: true } } } } } });
      if (p.availability === "pre_order") return;
      const waiting = await tx.reservation.findMany({ where: { dropId, status: "reserved" }, orderBy: { depositPaidAt: "asc" } });
      for (const r of waiting) await tryHold(tx, r, p.availability);
      const fresh = await tx.stockLevel.findMany({ where: { variant: { productId: d.productId } }, select: { onHand: true, reserved: true } });
      const available = fresh.reduce((n, l) => n + Math.max(0, l.onHand - l.reserved), 0);
      const next = available <= 0 ? "sold_out" : "live";
      if (next !== d.status) await tx.drop.update({ where: { id: d.id }, data: { status: next } });
    });
  },

  /** job drops.release: open drops whose time has come, keep live/sold-out in step with stock */
  async releaseDue(now = new Date()) {
    const due = await prisma.drop.findMany({ where: { status: "upcoming", releaseAt: { lte: now } }, select: { id: true } });
    let released = 0;
    for (const d of due) {
      try {
        await this.markLive(d.id, "system");
        released++;
      } catch (err) {
        if (!(err instanceof ApiError && err.code === "INVALID_STATE")) logger.error({ err, dropId: d.id }, "drop release failed");
      }
    }
    const open = await prisma.drop.findMany({ where: { status: { in: ["live", "sold_out"] } }, select: { id: true } });
    for (const d of open) await this.syncStatus(d.id);
    return { released };
  },

  /** job reservations.expire: unpaid deposits after the hold, unpaid balances after the window */
  async expireDue(now = new Date()) {
    const s = await settingsService.get("drops");
    let cancelled = 0;
    let expired = 0;
    const settlePending = async (id: string) => {
      // the gateway may have taken the money without the webhook arriving yet → check first
      const pending = await prisma.payment.findMany({ where: { targetType: TARGET, targetId: id, status: "pending" } });
      for (const p of pending) await paymentsService.settle(p.reference).catch(() => undefined);
    };

    const stale = await prisma.reservation.findMany({ where: { status: "pending_deposit", holdExpiresAt: { lt: now } }, select: { id: true } });
    for (const { id } of stale) {
      await settlePending(id);
      await run(async (tx) => {
        const r = await lockReservation(tx, id);
        if (!r || r.status !== "pending_deposit" || (r.holdExpiresAt && r.holdExpiresAt >= now)) return;
        cancelled++;
        return cancelInTx(tx, r, { reason: HOLD_LAPSED, actor: "system", refundTo: "none" });
      });
    }

    const windowStart = new Date(now.getTime() - s.balanceWindowHours * 3_600_000);
    const overdue = await prisma.reservation.findMany({
      where: { status: "reserved", drop: { status: { in: ["live", "sold_out", "ended"] }, releaseAt: { lt: windowStart } } },
      select: { id: true },
    });
    for (const { id } of overdue) {
      await settlePending(id);
      await run(async (tx) => {
        const r = await lockReservation(tx, id);
        if (!r || r.status !== "reserved") return;
        expired++;
        return expireInTx(tx, r, s);
      });
    }
    return { cancelled, expired };
  },

  /** admin "end drop": outstanding reservations are cancelled with the deposit refunded (the store's call, not the customer's) */
  async cancelOutstanding(tx: Tx, dropId: string, actor: string) {
    const rows = await tx.reservation.findMany({ where: { dropId, status: { in: ["pending_deposit", "reserved"] } } });
    const after: AfterCommit[] = [];
    for (const row of rows) {
      const r = await lockReservation(tx, row.id);
      if (r) after.push(await cancelInTx(tx, r, { reason: "The drop was ended", actor, refundTo: "original" }));
    }
    return after;
  },
};

// ── payments ──
paymentsService.register("reservation_deposit", {
  async succeeded(tx, p: Payment) {
    const r = p.targetId ? await lockReservation(tx, p.targetId) : null;
    const refund = async (why: string) => {
      // never keep money we can't honour
      await paymentsService.refund(tx, p.id, p.amount, why, "system");
      logger.warn({ reference: p.reference, reservation: r?.number, why }, "drop deposit refunded");
    };
    if (!r) return refund("Reservation no longer exists");
    if (r.depositPaidAt || (r.status !== "pending_deposit" && r.status !== "cancelled")) return refund("Deposit already paid");
    // only a hold that simply ran out may come back; a reservation the customer / staff cancelled stays cancelled
    if (r.status === "cancelled" && r.cancelReason !== HOLD_LAPSED) return refund("Reservation was cancelled");
    if (p.amount !== r.deposit) return refund("Deposit amount changed");
    const d = await lockDrop(tx, r.dropId);
    const other = await tx.reservation.count({ where: { dropId: d.id, customerId: r.customerId, status: { in: [...ACTIVE] }, id: { not: r.id } } });
    // a late payment for a lapsed hold is still honoured while there is room
    const fits = d.status === "upcoming" && d.releaseAt > new Date() && !other && d.reservedCount + (await livePending(tx, d.id, r.id)) < d.allocation;
    if (!fits) {
      await refund("Allocation no longer available");
      if (r.status === "pending_deposit")
        await tx.reservation.update({ where: { id: r.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "Allocation no longer available", holdExpiresAt: null } });
      return;
    }
    await tx.drop.update({ where: { id: d.id }, data: { reservedCount: { increment: 1 } } });
    await tx.reservation.update({ where: { id: r.id }, data: { status: "reserved", depositPaidAt: new Date(), holdExpiresAt: null, cancelledAt: null, cancelReason: null } });
    const paid = await tx.payment.findUniqueOrThrow({ where: { id: p.id } });
    return async () => {
      await dropsLedger.deposit(r.number, paid);
      await notify(r.id, "reservation.confirmed", {}, true);
    };
  },
});

paymentsService.register("order_balance", {
  async succeeded(tx, p: Payment) {
    const r = p.targetId && p.targetType === TARGET ? await lockReservation(tx, p.targetId) : null;
    if (!r || r.status !== "reserved" || p.amount !== r.balance) {
      const why = !r ? "Reservation no longer exists" : r.status === "balance_paid" ? "Balance already paid" : r.status === "reserved" ? "Balance amount changed" : `Reservation ${r.status}`;
      await paymentsService.refund(tx, p.id, p.amount, why, "system");
      logger.warn({ reference: p.reference, reservation: r?.number, why }, "drop balance refunded");
      return;
    }
    const { after } = await convertInTx(tx, r, p);
    return after;
  },
});

export const dropsReleaseJob = defineJob("drops.release", async () => {
  await reservationsService.releaseDue();
});

export const reservationsExpireJob = defineJob("reservations.expire", async () => {
  await reservationsService.expireDue();
});
