/**
 * Shipments (asl-admin /shipments). A shipment drives its order:
 * picked_up / in_transit → order shipped, out_for_delivery → out_for_delivery, delivered → delivered.
 */
import type { Prisma, ShipmentStatus } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { ordersService } from "@/modules/commerce/orders/orders.service";
import { pickupsService } from "@/modules/fulfilment/pickups/pickups.service";
import { CARRIER_LABEL, SHIPMENT_LABEL, shipmentInclude, toAdminShipment, toCustomerShipment } from "./shipments.mapper";
import type { AdvanceBody, CreateShipmentBody, FulfilBody, ShipmentListQuery, UpdateShipmentBody } from "./shipments.schemas";

const OPEN: ShipmentStatus[] = ["label_created", "picked_up", "in_transit", "out_for_delivery"];

/** allowed moves; in_transit → in_transit records another scan */
const NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  label_created: ["picked_up", "exception"],
  picked_up: ["in_transit", "out_for_delivery", "exception"],
  in_transit: ["in_transit", "out_for_delivery", "delivered", "exception", "returned"],
  out_for_delivery: ["delivered", "exception", "returned"],
  exception: ["in_transit", "out_for_delivery", "returned"],
  delivered: [],
  returned: [],
};

const ORDER_STATUS_FOR: Partial<Record<ShipmentStatus, "shipped" | "out_for_delivery" | "delivered">> = {
  picked_up: "shipped",
  in_transit: "shipped",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
};

type OrderChange = { orderId: string; from: string; to: string; shipmentId: string } | null;

/** after commit: tell the rest of the system the order moved */
function emitOrderChange(c: OrderChange) {
  if (!c) return;
  events.emit("order.status_changed", { orderId: c.orderId, from: c.from, to: c.to });
  if (c.to === "shipped") events.emit("order.shipped", { orderId: c.orderId, shipmentId: c.shipmentId });
  if (c.to === "delivered") events.emit("order.delivered", { orderId: c.orderId });
}

async function warehouseMap() {
  const rows = await prisma.warehouse.findMany({ select: { id: true, name: true, city: true } });
  return new Map(rows.map((w) => [w.id, w]));
}

const destinationOf = (a: unknown) => {
  const x = (a ?? {}) as { city?: string; state?: string; country?: string };
  return [x.city, x.state, x.country].filter(Boolean).join(", ") || "—";
};

/** which order status the shipment should push the order to (all of the order's live shipments count for "delivered") */
async function orderTarget(tx: Tx, orderId: string, status: ShipmentStatus) {
  const t = ORDER_STATUS_FOR[status];
  if (t !== "delivered") return t ?? null;
  const pending = await tx.shipment.count({ where: { orderId, status: { notIn: ["delivered", "returned"] } } });
  return pending ? ("shipped" as const) : ("delivered" as const);
}

export const shipmentsService = {
  NEXT,

  // ── create ──
  async fulfil(orderRef: string, b: FulfilBody, actor: string) {
    const o = await prisma.order.findFirst({ where: { OR: [{ id: orderRef }, { number: orderRef }] }, include: { items: { select: { qty: true } }, pickupBooking: { select: { number: true } } } });
    if (!o) throw ApiError.notFound("Order");
    if (o.deliveryMethod === "pickup")
      throw ApiError.conflict(
        "INVALID_STATE",
        `${o.number} is a pick-up order. It is fulfilled from Pick-ups → Bookings${o.pickupBooking ? ` (${o.pickupBooking.number})` : ""}, not with a shipment.`,
        { deliveryMethod: "pickup", bookingNumber: o.pickupBooking?.number ?? null },
      );
    if (!["paid", "processing"].includes(o.status))
      throw ApiError.conflict("INVALID_STATE", `Only paid orders that haven't shipped can be fulfilled (this one is "${STATUS_LABELS.order.admin[o.status]}").`);

    let originWarehouseId = b.originWarehouseId ?? null;
    if (originWarehouseId) {
      if (!(await prisma.warehouse.findUnique({ where: { id: originWarehouseId } }))) throw ApiError.badRequest("VALIDATION_FAILED", "Unknown warehouse.");
    } else {
      originWarehouseId = (await prisma.warehouse.findFirst({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }))?.id ?? null;
    }
    const wh = originWarehouseId ? await prisma.warehouse.findUnique({ where: { id: originWarehouseId } }) : null;

    const { shipmentId, change } = await prisma.$transaction(async (tx) => {
      const number = formatters.shipment(await nextSequence(tx, "shipment", 10248));
      const s = await tx.shipment.create({
        data: {
          number, orderId: o.id, carrier: b.carrier, service: b.service, trackingNumber: b.trackingNumber || null, originWarehouseId,
          destination: destinationOf(o.shippingAddress), weightKg: b.weightKg ?? 0, itemsCount: o.items.reduce((n, i) => n + i.qty, 0),
          declaredValue: o.subtotal, cost: b.cost ?? 0, insured: b.insured ?? false, signatureRequired: b.signatureRequired ?? false,
          etaAt: b.etaAt ?? o.expectedDeliveryAt ?? null, notes: b.notes ?? null,
          events: { create: { status: "label_created", location: wh ? `${wh.name}, ${wh.city}` : "Warehouse", note: "Label created" } },
        },
      });
      await ordersService.addEvent(tx, o.id, "note", `Shipment ${number} created`, { detail: `${CARRIER_LABEL[b.carrier]} · ${b.service}${b.trackingNumber ? ` · ${b.trackingNumber}` : ""}`, actor, internal: true });
      const c = await ordersService.syncFromFulfilment(tx, o.id, "processing", actor);
      return { shipmentId: s.id, change: c ? { orderId: o.id, shipmentId: s.id, ...c } : null };
    });
    emitOrderChange(change);
    return this.get(shipmentId);
  },

  create(b: CreateShipmentBody, actor: string) {
    const { orderId, ...rest } = b;
    return this.fulfil(orderId, rest, actor);
  },

  // ── read ──
  where(q: ShipmentListQuery): Prisma.ShipmentWhereInput {
    const and: Prisma.ShipmentWhereInput[] = [];
    if (q.tab !== "all") and.push({ status: q.tab });
    if (q.carrier) and.push({ carrier: q.carrier });
    if (q.orderId) and.push({ order: { OR: [{ id: q.orderId }, { number: q.orderId }] } });
    if (q.q)
      and.push({
        OR: [
          { number: { contains: q.q } }, { trackingNumber: { contains: q.q } },
          { order: { number: { contains: q.q } } }, { order: { guestEmail: { contains: q.q } } },
          { order: { customer: { OR: [{ email: { contains: q.q } }, { firstName: { contains: q.q } }, { lastName: { contains: q.q } }] } } },
        ],
      });
    return { AND: and };
  },

  async list(q: ShipmentListQuery) {
    const where = this.where(q);
    const since = new Date(Date.now() - 30 * 86_400_000);
    const sort: Prisma.ShipmentOrderByWithRelationInput =
      q.sort === "etaAt" ? { etaAt: "asc" } : q.sort === "-etaAt" ? { etaAt: "desc" } : q.sort === "createdAt" ? { createdAt: "asc" } : { createdAt: "desc" };
    const [rows, total, groups, delivered30, whs] = await Promise.all([
      prisma.shipment.findMany({ where, ...paging(q), orderBy: sort, include: shipmentInclude }),
      prisma.shipment.count({ where }),
      prisma.shipment.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.shipment.findMany({ where: { status: "delivered", deliveredAt: { gte: since } }, select: { createdAt: true, shippedAt: true, deliveredAt: true } }),
      warehouseMap(),
    ]);
    const count = (s: ShipmentStatus[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const tabs = Object.fromEntries([["all", count(Object.keys(NEXT) as ShipmentStatus[])], ...(Object.keys(NEXT) as ShipmentStatus[]).map((s) => [s, count([s])])]);
    const days = delivered30.map((s) => (s.deliveredAt!.getTime() - (s.shippedAt ?? s.createdAt).getTime()) / 86_400_000);
    const kpis = {
      inTransit: count(["picked_up", "in_transit", "out_for_delivery"]),
      delivered30d: delivered30.length,
      exceptions: count(["exception"]),
      avgDeliveryDays: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    };
    return withMeta(rows.map((r) => toAdminShipment(r, whs)), { ...pageMeta(q, total), tabs, kpis, labels: SHIPMENT_LABEL, carriers: CARRIER_LABEL });
  },

  async get(id: string) {
    const s = await prisma.shipment.findFirst({ where: { OR: [{ id }, { number: id }] }, include: shipmentInclude });
    if (!s) throw ApiError.notFound("Shipment");
    return { ...toAdminShipment(s, await warehouseMap()), next: NEXT[s.status] };
  },

  // ── change ──
  async update(id: string, b: UpdateShipmentBody) {
    const before = await prisma.shipment.findFirst({ where: { OR: [{ id }, { number: id }] } });
    if (!before) throw ApiError.notFound("Shipment");
    if (b.originWarehouseId && !(await prisma.warehouse.findUnique({ where: { id: b.originWarehouseId } })))
      throw ApiError.badRequest("VALIDATION_FAILED", "Unknown warehouse.");
    if (b.carrier && b.carrier !== before.carrier && before.status !== "label_created")
      throw ApiError.conflict("INVALID_STATE", "The carrier can only be changed before the parcel is picked up.");
    await prisma.shipment.update({
      where: { id: before.id },
      data: {
        carrier: b.carrier, service: b.service, trackingNumber: b.trackingNumber === undefined ? undefined : b.trackingNumber || null,
        weightKg: b.weightKg, cost: b.cost, insured: b.insured, signatureRequired: b.signatureRequired, etaAt: b.etaAt, notes: b.notes,
        originWarehouseId: b.originWarehouseId,
      },
    });
    return { before, after: await this.get(before.id) };
  },

  async advance(id: string, b: AdvanceBody, actor: string) {
    const s = await prisma.shipment.findFirst({ where: { OR: [{ id }, { number: id }] } });
    if (!s) throw ApiError.notFound("Shipment");
    if (!NEXT[s.status].includes(b.status))
      throw ApiError.conflict("INVALID_STATE", `Can't move a shipment from "${SHIPMENT_LABEL[s.status]}" to "${SHIPMENT_LABEL[b.status]}".`, { allowed: NEXT[s.status] });
    const change = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.shipment.update({
        where: { id: s.id },
        data: {
          status: b.status,
          ...(["picked_up", "in_transit", "out_for_delivery", "delivered"].includes(b.status) && !s.shippedAt ? { shippedAt: now } : {}),
          ...(b.status === "delivered" ? { deliveredAt: now } : {}),
        },
      });
      await tx.shipmentEvent.create({ data: { shipmentId: s.id, status: b.status, location: b.location, note: b.note } });
      if (b.status === "exception" || b.status === "returned")
        await ordersService.addEvent(tx, s.orderId, "note", `Shipment ${s.number}: ${SHIPMENT_LABEL[b.status]}`, { detail: [b.location, b.note].filter(Boolean).join(" — "), actor, internal: true });
      const target = await orderTarget(tx, s.orderId, b.status);
      if (!target) return null;
      // a parcel that skipped "picked up" still passes through "shipped" so the customer gets the shipped notice
      let first: Awaited<ReturnType<typeof ordersService.syncFromFulfilment>> = null;
      if (target !== "shipped") first = await ordersService.syncFromFulfilment(tx, s.orderId, "shipped", actor);
      const c = await ordersService.syncFromFulfilment(tx, s.orderId, target, actor);
      return { shipped: first ? { ...first, orderId: s.orderId, shipmentId: s.id } : null, last: c ? { ...c, orderId: s.orderId, shipmentId: s.id } : null };
    });
    emitOrderChange(change?.shipped ?? null);
    emitOrderChange(change?.last ?? null);
    return this.get(s.id);
  },

  async remove(id: string) {
    const s = await prisma.shipment.findFirst({ where: { OR: [{ id }, { number: id }] } });
    if (!s) throw ApiError.notFound("Shipment");
    if (s.status !== "label_created") throw ApiError.conflict("INVALID_STATE", "Only shipments still at \"Label created\" can be deleted.");
    await prisma.$transaction(async (tx) => {
      await tx.shipment.delete({ where: { id: s.id } });
      await ordersService.addEvent(tx, s.orderId, "note", `Shipment ${s.number} deleted`, { internal: true });
    });
    return { deleted: true, number: s.number };
  },

  /** order cancelled before the parcel left: drop labels that were never used */
  async dropUnusedLabels(orderId: string) {
    await prisma.shipment.deleteMany({ where: { orderId, status: "label_created" } });
  },

  // ── customer tracking ──
  async tracking(where: Prisma.OrderWhereInput) {
    const o = await prisma.order.findFirst({
      where,
      include: {
        shipments: { orderBy: { createdAt: "desc" }, include: { events: { orderBy: { createdAt: "asc" } } } },
        pickupLocation: true,
        events: { where: { internal: false }, orderBy: { createdAt: "asc" } },
      },
    });
    if (!o) throw ApiError.notFound("Order");
    const live = o.shipments.find((s) => OPEN.includes(s.status) || s.status === "exception") ?? o.shipments[0];
    return {
      orderId: o.id,
      number: o.number,
      status: STATUS_LABELS.order.customer[o.status],
      statusKey: o.status,
      delivery: o.deliveryMethod,
      placedAt: o.placedAt,
      deliveredAt: o.deliveredAt,
      eta: live?.etaAt ?? o.expectedDeliveryAt,
      shipments: o.shipments.map(toCustomerShipment),
      pickup: o.deliveryMethod === "pickup" ? await pickupsService.customerBooking(o.id, o.pickupLocation) : null,
      timeline: o.events.map((e) => ({ type: e.type, title: e.title, detail: e.detail, at: e.createdAt })),
    };
  },
};
