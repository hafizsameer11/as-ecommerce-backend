/**
 * Returns / RMA.
 * requested → approved → in_transit_back → received → refunded
 * side exits: under_investigation (from any open step), rejected (also used when the customer cancels).
 * The refund itself goes through ordersService.refund so the money rules live in one place.
 */
import type { OrderStatus, Prisma, ReturnStatus } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { formatNaira } from "@/core/utils/money";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import { ordersService } from "@/modules/commerce/orders/orders.service";
import { OPEN_STATUSES, returnInclude, returnLines, toAdminReturn, toAdminReturnRow, toCustomerReturn, toCustomerReturnCard, type ReturnRow } from "./returns.mapper";
import { DAMAGED_REASON, RETURN_REASONS, type AdminCreateBody, type AdminReturnsQuery, type CreateReturnBody, type MyReturnsQuery, type ReceivedBody, type ReturnRefundBody } from "./returns.schemas";

const DAY = 86_400_000;
const RETURNABLE_ORDER: OrderStatus[] = ["delivered", "partially_refunded"];
const MAX_PHOTOS = 5;

type ReturnsSettings = SettingsOf<"returns">;
type Line = { orderItemId: string; qty: number };

export type NotReturnableReason = "NOT_DELIVERED" | "RETURN_WINDOW_CLOSED" | "NON_RETURNABLE_CATEGORY" | "ALREADY_RETURNED";
const REASON_TEXT: Record<NotReturnableReason, (cfg: ReturnsSettings) => string> = {
  NOT_DELIVERED: () => "Returns open once the order has been delivered.",
  RETURN_WINDOW_CLOSED: (cfg) => `The ${cfg.windowDays}-day return window has closed.`,
  NON_RETURNABLE_CATEGORY: () => "This item can't be returned for hygiene / safety reasons.",
  ALREADY_RETURNED: () => "Already returned or in a return request.",
};

const orderForReturn = {
  items: { include: { product: { select: { category: { select: { handle: true, name: true } }, subcategory: { select: { handle: true } } } } } },
} satisfies Prisma.OrderInclude;
type OrderForReturn = Prisma.OrderGetPayload<{ include: typeof orderForReturn }>;

async function loadOrder(where: Prisma.OrderWhereInput) {
  const o = await prisma.order.findFirst({ where, include: orderForReturn });
  if (!o) throw ApiError.notFound("Order");
  return o;
}

/** qty per order line sitting in returns that are still open (refunded ones are counted in OrderItem.qtyReturned) */
async function openQty(db: Tx | typeof prisma, orderId: string) {
  const rows = await db.returnItem.findMany({ where: { returnReq: { orderId, status: { in: OPEN_STATUSES } } }, select: { orderItemId: true, qty: true } });
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.orderItemId, (m.get(r.orderItemId) ?? 0) + r.qty);
  return m;
}

/** per-line eligibility. `override` (admin goodwill) skips the window and category rules. */
function assess(o: OrderForReturn, open: Map<string, number>, cfg: ReturnsSettings, override = false) {
  const delivered = RETURNABLE_ORDER.includes(o.status);
  const deliveredAt = delivered ? (o.deliveredAt ?? o.updatedAt) : o.deliveredAt;
  const windowEndsAt = deliveredAt ? new Date(deliveredAt.getTime() + cfg.windowDays * DAY) : null;
  const windowClosed = !!windowEndsAt && Date.now() > windowEndsAt.getTime();
  const blocked = new Set(cfg.nonReturnableCategories.map((h) => h.toLowerCase()));
  const items = o.items.map((i) => {
    const requested = open.get(i.id) ?? 0;
    const remaining = Math.max(0, i.qty - i.qtyReturned - requested);
    const cat = i.product?.category.handle.toLowerCase();
    const sub = i.product?.subcategory?.handle.toLowerCase();
    const nonReturnable = (!!cat && blocked.has(cat)) || (!!sub && blocked.has(sub));
    const reason: NotReturnableReason | null =
      !delivered ? "NOT_DELIVERED"
      : windowClosed && !override ? "RETURN_WINDOW_CLOSED"
      : nonReturnable && !override ? "NON_RETURNABLE_CATEGORY"
      : remaining <= 0 ? "ALREADY_RETURNED"
      : null;
    return {
      orderItemId: i.id, name: i.name, brand: i.brand, size: i.size, color: i.color, image: i.imageUrl, unitPrice: i.unitPrice,
      category: i.product?.category.name ?? null,
      bought: i.qty, returned: i.qtyReturned, requested,
      returnable: reason ? 0 : remaining,
      reason, reasonText: reason ? REASON_TEXT[reason](cfg) : null,
    };
  });
  const orderReason: NotReturnableReason | null = !delivered ? "NOT_DELIVERED" : windowClosed && !override ? "RETURN_WINDOW_CLOSED" : null;
  return { delivered, deliveredAt, windowEndsAt, windowClosed, orderReason, items, eligible: items.some((i) => i.returnable > 0) };
}

/** throws the first rule a requested line breaks */
function checkLines(a: ReturnType<typeof assess>, lines: Line[], cfg: ReturnsSettings) {
  if (!a.delivered) throw ApiError.conflict("INVALID_STATE", REASON_TEXT.NOT_DELIVERED(cfg));
  for (const l of lines) {
    const it = a.items.find((i) => i.orderItemId === l.orderItemId);
    if (!it) throw ApiError.badRequest("VALIDATION_FAILED", "One of the items is not part of this order.", [{ orderItemId: l.orderItemId }]);
    if (it.reason === "RETURN_WINDOW_CLOSED") throw ApiError.badRequest("RETURN_WINDOW_CLOSED", it.reasonText!);
    if (it.reason === "NON_RETURNABLE_CATEGORY") throw ApiError.badRequest("VALIDATION_FAILED", `${it.name}: ${it.reasonText}`, [{ orderItemId: it.orderItemId, reason: it.reason }]);
    if (l.qty > it.returnable)
      throw ApiError.badRequest("VALIDATION_FAILED", it.returnable ? `You can return up to ${it.returnable} of ${it.name}.` : `${it.name}: ${REASON_TEXT.ALREADY_RETURNED(cfg)}`, [
        { orderItemId: it.orderItemId, requested: l.qty, returnable: it.returnable },
      ]);
  }
}

/** Σ unitPrice × qty, less the order's share of discount, capped at what's still refundable on the order */
function suggestedRefund(o: { subtotal: number; discount: number; amountPaid: number; amountRefunded: number; items: { id: string; unitPrice: number }[] }, lines: Line[]) {
  const gross = lines.reduce((n, l) => n + (o.items.find((i) => i.id === l.orderItemId)?.unitPrice ?? 0) * l.qty, 0);
  const share = o.subtotal > 0 ? 1 - Math.min(o.discount, o.subtotal) / o.subtotal : 1;
  return Math.max(0, Math.min(Math.round(gross * share), o.amountPaid - o.amountRefunded));
}

async function findReturn(where: Prisma.ReturnRequestWhereInput) {
  const r = await prisma.returnRequest.findFirst({ where, include: returnInclude });
  if (!r) throw ApiError.notFound("Return");
  return r;
}

const byIdOrNumber = (id: string): Prisma.ReturnRequestWhereInput => ({ OR: [{ id }, { number: id.toUpperCase() }] });

/** inside a transaction: re-check under the order lock, then write the request + its first event */
async function insertReturn(
  tx: Tx,
  o: OrderForReturn,
  input: { lines: Line[]; reason: string; details?: string; refundTo: "original" | "wallet"; photos: string[]; refundAmount?: number; override: boolean; actor: string; note?: string },
  cfg: ReturnsSettings,
) {
  await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${o.id} FOR UPDATE`;
  const fresh = await tx.order.findUniqueOrThrow({ where: { id: o.id }, include: orderForReturn });
  checkLines(assess(fresh, await openQty(tx, o.id), cfg, input.override), input.lines, cfg);
  const number = formatters.return(await nextSequence(tx, "return", 2210));
  const r = await tx.returnRequest.create({
    data: {
      number, orderId: o.id, customerId: o.customerId, reason: input.reason, details: input.details || null,
      photos: input.photos, refundTo: input.refundTo,
      refundAmount: input.refundAmount ?? suggestedRefund(fresh, input.lines),
      items: { create: input.lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty })) },
      events: { create: { status: "requested", note: input.note ?? "Return requested", actor: input.actor } },
    },
  });
  return r;
}

async function addEvent(tx: Tx, returnId: string, status: ReturnStatus, actor: string, note?: string | null) {
  await tx.returnEvent.create({ data: { returnId, status, actor, note: note ? note.slice(0, 500) : null } });
}

const label = (s: ReturnStatus) => STATUS_LABELS.return.admin[s];

export const returnsService = {
  REASONS: RETURN_REASONS,
  suggestedRefund,

  // ── customer ──
  async returnable(customerId: string, orderRef: string) {
    const cfg = await settingsService.get("returns");
    const o = await loadOrder({ customerId, OR: [{ id: orderRef }, { number: orderRef }] });
    const a = assess(o, await openQty(prisma, o.id), cfg);
    return {
      orderId: o.id,
      orderNumber: o.number,
      status: STATUS_LABELS.order.customer[o.status],
      statusKey: o.status,
      deliveredAt: a.deliveredAt,
      windowDays: cfg.windowDays,
      windowEndsAt: a.windowEndsAt,
      eligible: a.eligible,
      reason: a.orderReason,
      reasonText: a.orderReason ? REASON_TEXT[a.orderReason](cfg) : null,
      items: a.items,
      reasons: RETURN_REASONS,
      photosRequiredFor: [DAMAGED_REASON],
      damagedReportHours: cfg.damagedReportHours,
      maxPhotos: MAX_PHOTOS,
      refundOptions: ["original", "wallet"],
    };
  },

  async create(customerId: string, b: CreateReturnBody, files: UploadInput[]) {
    const cfg = await settingsService.get("returns");
    const o = await loadOrder({ customerId, OR: [{ id: b.orderId }, { number: b.orderId }] });
    const a = assess(o, await openQty(prisma, o.id), cfg);
    checkLines(a, b.items, cfg);
    if (b.reason === DAMAGED_REASON) {
      if (!files.length) throw ApiError.badRequest("VALIDATION_FAILED", "Please add at least one photo of the damage.", [{ in: "body", path: "photos", message: "Required" }]);
      const since = a.deliveredAt ? Date.now() - a.deliveredAt.getTime() : 0;
      if (since > cfg.damagedReportHours * 3_600_000)
        throw ApiError.badRequest("RETURN_WINDOW_CLOSED", `Damaged or defective items must be reported within ${cfg.damagedReportHours} hours of delivery.`);
    }
    const photos: string[] = [];
    for (const f of files.slice(0, MAX_PHOTOS)) {
      const m = await mediaService.upload(f, "returns", `customer:${customerId}`);
      photos.push((m.variants as Record<string, string> | null)?.lg ?? m.url);
    }
    const r = await prisma.$transaction((tx) =>
      insertReturn(tx, o, { lines: b.items, reason: b.reason, details: b.details, refundTo: b.refundTo, photos, override: false, actor: "customer" }, cfg),
    );
    events.emit("return.updated", { returnId: r.id, status: r.status });
    return this.myReturn(customerId, r.id);
  },

  async myReturns(customerId: string, q: MyReturnsQuery) {
    const map: Record<string, ReturnStatus[]> = {
      "In Progress": ["requested", "under_investigation"],
      Approved: ["approved", "in_transit_back", "received"],
      Completed: ["refunded"],
      Rejected: ["rejected"],
    };
    const where: Prisma.ReturnRequestWhereInput = { customerId, ...(q.status ? { status: { in: map[q.status] } } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.returnRequest.findMany({ where, include: returnInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.returnRequest.count({ where }),
      prisma.returnRequest.groupBy({ by: ["status"], where: { customerId }, _count: { _all: true } }),
    ]);
    const tabs = Object.fromEntries(
      Object.entries(map).map(([k, s]) => [k, groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0)]),
    );
    const cfg = await settingsService.get("returns");
    return withMeta(rows.map(toCustomerReturnCard), {
      ...pageMeta(q, total), tabs,
      policy: { windowDays: cfg.windowDays, refundProcessingDays: cfg.refundProcessingDays, nonReturnableCategories: cfg.nonReturnableCategories },
    });
  },

  async myReturn(customerId: string, id: string) {
    const r = await findReturn({ customerId, ...byIdOrNumber(id) });
    const cfg = await settingsService.get("returns");
    return toCustomerReturn(r, cfg);
  },

  async cancelByCustomer(customerId: string, id: string) {
    const r = await findReturn({ customerId, ...byIdOrNumber(id) });
    if (r.status !== "requested") throw ApiError.conflict("INVALID_STATE", "This return is already being processed and can't be cancelled. Contact us if you need help.");
    await prisma.$transaction(async (tx) => {
      const n = await tx.returnRequest.updateMany({ where: { id: r.id, status: "requested" }, data: { status: "rejected" } });
      if (!n.count) throw ApiError.conflict("INVALID_STATE", "This return was just updated. Refresh and try again.");
      await addEvent(tx, r.id, "rejected", "customer", "Cancelled by customer");
    });
    events.emit("return.updated", { returnId: r.id, status: "rejected" });
    return this.myReturn(customerId, r.id);
  },

  // ── admin ──
  where(q: AdminReturnsQuery): Prisma.ReturnRequestWhereInput {
    const tabs: Record<AdminReturnsQuery["tab"], Prisma.ReturnRequestWhereInput> = {
      all: {},
      open: { status: { in: OPEN_STATUSES } },
      awaiting_review: { status: "requested" },
      approved: { status: "approved" },
      in_transit: { status: "in_transit_back" },
      received: { status: "received" },
      investigating: { status: "under_investigation" },
      refunded: { status: "refunded" },
      rejected: { status: "rejected" },
    };
    const and: Prisma.ReturnRequestWhereInput[] = [tabs[q.tab]];
    if (q.q)
      and.push({
        OR: [
          { number: { contains: q.q } }, { reason: { contains: q.q } }, { order: { number: { contains: q.q } } },
          { customer: { OR: [{ email: { contains: q.q } }, { firstName: { contains: q.q } }, { lastName: { contains: q.q } }, { phone: { contains: q.q } }] } },
        ],
      });
    if (q.customerId) and.push({ customerId: q.customerId });
    if (q.orderId) and.push({ order: { OR: [{ id: q.orderId }, { number: q.orderId }] } });
    return { AND: and };
  },

  async adminList(q: AdminReturnsQuery) {
    const where = this.where(q);
    const sort: Prisma.ReturnRequestOrderByWithRelationInput =
      q.sort === "refund" ? { refundAmount: "asc" } : q.sort === "-refund" ? { refundAmount: "desc" } : q.sort === "createdAt" ? { createdAt: "asc" } : { createdAt: "desc" };
    const since = new Date(Date.now() - 30 * DAY);
    const [rows, total, groups, refunded, created30, orders30, resolved] = await Promise.all([
      prisma.returnRequest.findMany({ where, include: returnInclude, orderBy: sort, ...paging(q) }),
      prisma.returnRequest.count({ where }),
      prisma.returnRequest.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.returnRequest.aggregate({ where: { status: "refunded", refundedAt: { gte: since } }, _sum: { refundAmount: true }, _count: { _all: true } }),
      prisma.returnRequest.count({ where: { createdAt: { gte: since } } }),
      prisma.order.count({ where: { paidAt: { gte: since } } }),
      prisma.returnRequest.findMany({ where: { status: { in: ["refunded", "rejected"] }, updatedAt: { gte: since } }, select: { createdAt: true, updatedAt: true }, take: 1000 }),
    ]);
    const c = (s: ReturnStatus[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const tabs = {
      all: c(Object.keys(STATUS_LABELS.return.admin) as ReturnStatus[]), open: c(OPEN_STATUSES), awaiting_review: c(["requested"]), approved: c(["approved"]),
      in_transit: c(["in_transit_back"]), received: c(["received"]), investigating: c(["under_investigation"]), refunded: c(["refunded"]), rejected: c(["rejected"]),
    };
    const kpis = {
      open: tabs.open,
      refunded30d: refunded._sum.refundAmount ?? 0,
      refundedCount30d: refunded._count._all,
      /** returns opened in the last 30 days ÷ orders paid in the last 30 days, % */
      returnRate30d: orders30 ? Math.round((created30 / orders30) * 1000) / 10 : 0,
      avgResolutionDays: resolved.length
        ? Math.round((resolved.reduce((n, r) => n + (r.updatedAt.getTime() - r.createdAt.getTime()), 0) / resolved.length / DAY) * 10) / 10
        : null,
    };
    return withMeta(rows.map(toAdminReturnRow), { ...pageMeta(q, total), tabs, kpis, labels: STATUS_LABELS.return.admin, reasons: RETURN_REASONS });
  },

  async adminGet(id: string) {
    const r = await findReturn(byIdOrNumber(id));
    return this.toAdmin(r);
  },

  toAdmin(r: ReturnRow) {
    const lines = r.items.map((i) => ({ orderItemId: i.orderItemId, qty: i.qty }));
    const refundable = Math.max(0, r.order.amountPaid - r.order.amountRefunded);
    return toAdminReturn(r, { suggestedRefund: suggestedRefund(r.order, lines), refundable });
  },

  /** "New RMA": on behalf of a customer (phone / in-store / email) */
  async adminCreate(b: AdminCreateBody, actor: string) {
    const cfg = await settingsService.get("returns");
    const o = await loadOrder({ OR: [{ id: b.orderId }, { number: b.orderId.toUpperCase() }] });
    if (b.refundTo === "wallet" && !o.customerId) throw ApiError.badRequest("VALIDATION_FAILED", "Guest orders can only be refunded to the original payment.");
    let lines = b.items;
    if (!lines) {
      const a = assess(o, await openQty(prisma, o.id), cfg, b.override);
      if (!a.delivered) throw ApiError.conflict("INVALID_STATE", REASON_TEXT.NOT_DELIVERED(cfg));
      lines = a.items.filter((i) => i.returnable > 0).map((i) => ({ orderItemId: i.orderItemId, qty: i.returnable }));
      if (!lines.length) {
        const why = a.items.find((i) => i.reason)?.reasonText ?? "Nothing left to return on this order.";
        throw ApiError.badRequest(a.orderReason === "RETURN_WINDOW_CLOSED" ? "RETURN_WINDOW_CLOSED" : "VALIDATION_FAILED", why);
      }
    }
    const items = lines;
    const r = await prisma.$transaction((tx) =>
      insertReturn(tx, o, {
        lines: items, reason: b.reason, details: b.details, refundTo: b.refundTo, photos: [], refundAmount: b.refundAmount,
        override: b.override, actor, note: `RMA created by ${actor}${b.override ? " (outside policy)" : ""}`,
      }, cfg),
    );
    events.emit("return.updated", { returnId: r.id, status: r.status });
    return this.adminGet(r.id);
  },

  /** guarded status change: only from `from`, one ReturnEvent, `return.updated` after commit */
  async transition(
    id: string, from: ReturnStatus[], to: ReturnStatus, actor: string, note: string | null | undefined,
    o: { data?: Prisma.ReturnRequestUpdateManyMutationInput; inTx?: (tx: Tx, r: ReturnRow) => Promise<void> } = {},
  ) {
    const r = await findReturn(byIdOrNumber(id));
    if (!from.includes(r.status)) throw ApiError.conflict("INVALID_STATE", `Can't move a return from "${label(r.status)}" to "${label(to)}".`);
    await prisma.$transaction(async (tx) => {
      const n = await tx.returnRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: to, ...o.data } });
      if (!n.count) throw ApiError.conflict("INVALID_STATE", "This return was just updated by someone else. Refresh and try again.");
      if (o.inTx) await o.inTx(tx, r);
      await addEvent(tx, r.id, to, actor, note);
    });
    events.emit("return.updated", { returnId: r.id, status: to });
    return this.adminGet(r.id);
  },

  approve(id: string, note: string | undefined, actor: string) {
    return this.transition(id, ["requested", "under_investigation"], "approved", actor, note ?? "Return approved");
  },

  reject(id: string, reason: string, actor: string) {
    return this.transition(id, OPEN_STATUSES, "rejected", actor, reason, { data: { inspectorNote: reason } });
  },

  inTransit(id: string, note: string | undefined, actor: string) {
    return this.transition(id, ["approved"], "in_transit_back", actor, note ?? "On its way back to us");
  },

  /** item arrived at the warehouse; optionally put it back on sale */
  received(id: string, b: ReceivedBody, actor: string) {
    return this.transition(id, ["approved", "in_transit_back", "under_investigation"], "received", actor, b.note ?? (b.restock ? "Received and restocked" : "Received"), {
      data: { ...(b.note ? { inspectorNote: b.note } : {}) },
      inTx: async (tx, r) => {
        if (!b.restock || r.restocked) return;
        for (const l of returnLines(r)) {
          if (l.variantId) await inventoryService.restock(tx, l.variantId, l.qty, { type: "return", id: r.id }, actor);
        }
        await tx.returnRequest.update({ where: { id: r.id }, data: { restocked: true } });
      },
    });
  },

  investigate(id: string, note: string, actor: string) {
    return this.transition(id, ["requested", "approved", "in_transit_back", "received"], "under_investigation", actor, note, { data: { inspectorNote: note } });
  },

  /** money back via ordersService.refund; the RMA is marked refunded in the same transaction */
  async refund(id: string, b: ReturnRefundBody, actor: string) {
    const r = await findReturn(byIdOrNumber(id));
    const FROM: ReturnStatus[] = ["approved", "in_transit_back", "received", "under_investigation"];
    if (!FROM.includes(r.status)) throw ApiError.conflict("INVALID_STATE", `Can't refund a return that is "${label(r.status)}".`);
    const lines = r.items.map((i) => ({ orderItemId: i.orderItemId, qty: i.qty }));
    const refundable = r.order.amountPaid - r.order.amountRefunded;
    const amount = b.amount ?? suggestedRefund(r.order, lines);
    if (amount <= 0 || refundable <= 0) throw ApiError.conflict("INVALID_STATE", "Nothing left to refund on this order.");
    if (amount > refundable) throw ApiError.badRequest("VALIDATION_FAILED", `You can refund up to ${formatNaira(refundable)}.`);
    const now = new Date();
    await ordersService.refund(r.order.id, { amount, reason: `Return ${r.number}`, to: b.to, restock: false }, actor, {
      inTx: async (tx) => {
        const n = await tx.returnRequest.updateMany({
          where: { id: r.id, status: { in: FROM } },
          data: { status: "refunded", refundAmount: amount, refundTo: b.to, refundedAt: now, ...(b.note ? { inspectorNote: b.note } : {}) },
        });
        if (!n.count) throw ApiError.conflict("INVALID_STATE", "This return was just updated by someone else. Refresh and try again.");
        for (const l of lines) await tx.orderItem.update({ where: { id: l.orderItemId }, data: { qtyReturned: { increment: l.qty } } });
        const items = await tx.orderItem.findMany({ where: { orderId: r.order.id }, select: { qty: true, qtyReturned: true } });
        if (items.every((i) => i.qtyReturned >= i.qty)) {
          await tx.order.update({ where: { id: r.order.id }, data: { status: "returned" } });
          await ordersService.addEvent(tx, r.order.id, "returned", "Returned", { detail: `Return ${r.number}`, actor });
        }
        await addEvent(tx, r.id, "refunded", actor, b.note ?? `${formatNaira(amount)} refunded to ${b.to === "wallet" ? "ASL Wallet" : "original payment"}`);
      },
    });
    events.emit("return.updated", { returnId: r.id, status: "refunded" });
    return this.adminGet(r.id);
  },
};
