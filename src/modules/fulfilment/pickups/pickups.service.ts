import type { PickupLocation, PickupStatus, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { logger } from "@/core/utils/logger";
import { ordersService } from "@/modules/commerce/orders/orders.service";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";
import type { BookingAdvanceBody, BookingListQuery, BookingRescheduleBody, LocationBody } from "./pickups.schemas";

const toStore = (l: { id: string; name: string; address: string; city: string; state: string; phone: string; hours: string; concierge: boolean }) => ({
  id: l.id, name: l.name, address: l.address, city: l.city, state: l.state, phone: l.phone, hours: l.hours, concierge: l.concierge,
});

// ── pick-up bookings: days are Lagos days (Africa/Lagos = UTC+1, no daylight saving) ──
const DAY = 86_400_000;
const LAGOS_OFFSET = 3_600_000;
/** start of the Lagos day containing `d`, as a UTC instant */
const lagosDayStart = (d: Date) => new Date(Math.floor((d.getTime() + LAGOS_OFFSET) / DAY) * DAY - LAGOS_OFFSET);
const lagosDayFromIso = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) - LAGOS_OFFSET);
const lagosLabel = (d: Date) =>
  d.toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const BOOKING_LABEL: Record<PickupStatus, string> = { scheduled: "Scheduled", ready: "Ready", collected: "Collected", no_show: "No-show", cancelled: "Cancelled" };
export const BOOKING_CUSTOMER_LABEL: Record<PickupStatus, string> = {
  scheduled: "Being prepared", ready: "Ready for pick-up", collected: "Collected", no_show: "Missed pick-up", cancelled: "Cancelled",
};
const BOOKING_NEXT: Record<PickupStatus, PickupStatus[]> = {
  scheduled: ["ready", "no_show", "cancelled"],
  ready: ["collected", "no_show", "cancelled"],
  no_show: ["ready", "collected", "cancelled"],
  collected: [],
  cancelled: [],
};
/** bookings that use up a slot */
const HOLDS_SLOT: PickupStatus[] = ["scheduled", "ready", "collected"];

const bookingInclude = {
  location: { select: { id: true, name: true, city: true, capacityPerDay: true } },
  order: {
    select: {
      id: true, number: true, status: true, contact: true, guestEmail: true, shippingAddress: true,
      customer: { select: { ...customerBrief, phone: true } }, items: { select: { qty: true } },
    },
  },
} satisfies Prisma.PickupBookingInclude;
type BookingRow = Prisma.PickupBookingGetPayload<{ include: typeof bookingInclude }>;

function toAdminBooking(b: BookingRow) {
  const contact = (b.order.contact ?? {}) as { email?: string; phone?: string };
  return {
    id: b.id,
    number: b.number,
    orderId: b.order.id,
    orderNumber: b.order.number,
    orderStatus: b.order.status,
    customerName: b.order.customer ? fullName(b.order.customer) : "Guest",
    customerEmail: contact.email ?? b.order.customer?.email ?? b.order.guestEmail ?? null,
    customerPhone: contact.phone || b.order.customer?.phone || null,
    locationId: b.locationId,
    locationName: b.location.name,
    scheduledAt: b.scheduledAt,
    status: b.status,
    statusLabel: BOOKING_LABEL[b.status],
    itemsCount: b.order.items.reduce((n, i) => n + i.qty, 0),
    notes: b.notes,
    createdAt: b.createdAt,
    collectedAt: b.collectedAt,
    collectedBy: b.collectedBy,
    next: BOOKING_NEXT[b.status],
  };
}

/** bookings holding a slot at a location on the Lagos day of `at` */
async function slotsUsed(db: Tx | typeof prisma, locationId: string, at: Date, exceptId?: string) {
  const from = lagosDayStart(at);
  return db.pickupBooking.count({
    where: { locationId, scheduledAt: { gte: from, lt: new Date(from.getTime() + DAY) }, status: { in: HOLDS_SLOT }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
}

export const pickupsService = {
  /** checkout "Pick up in store" + store locator */
  async storeLocations() {
    const rows = await prisma.pickupLocation.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    return rows.map(toStore);
  },

  async activeLocation(id: string) {
    const l = await prisma.pickupLocation.findFirst({ where: { id, active: true } });
    if (!l) throw ApiError.badRequest("VALIDATION_FAILED", "That pick-up store is not available. Choose another one.");
    return l;
  },

  // ── admin /pickups → locations tab ──
  async listLocations() {
    const since = new Date(Date.now() - 30 * DAY);
    const rows = await prisma.pickupLocation.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { bookings: { where: { scheduledAt: { gte: since } } } } } },
    });
    return rows.map((l) => ({
      id: l.id, name: l.name, address: l.address, city: l.city, state: l.state, country: l.country,
      phone: l.phone, hours: l.hours, active: l.active, concierge: l.concierge, capacityPerDay: l.capacityPerDay,
      bookingsLast30: l._count.bookings, createdAt: l.createdAt, updatedAt: l.updatedAt,
    }));
  },
  async createLocation(b: LocationBody) {
    const row = await prisma.pickupLocation.create({
      data: {
        name: b.name,
        address: b.address || "Address TBD",
        city: b.city || "Lagos",
        state: b.state || "Lagos",
        country: b.country,
        phone: b.phone || "+234",
        hours: b.hours || "Mon - Sat 10:00 - 19:00",
        active: b.active,
        concierge: b.concierge,
        capacityPerDay: b.capacityPerDay,
      },
    });
    return { ...row, bookingsLast30: 0 };
  },
  async updateLocation(id: string, b: Partial<LocationBody>) {
    const before = await prisma.pickupLocation.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Pick-up location");
    const after = await prisma.pickupLocation.update({ where: { id }, data: b });
    return { before, after };
  },
  async removeLocation(id: string) {
    const used = await prisma.order.count({ where: { pickupLocationId: id } });
    if (used) {
      // keep history intact: deactivate instead of deleting
      await prisma.pickupLocation.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true };
    }
    await prisma.pickupLocation.delete({ where: { id } });
    return { deleted: true };
  },

  // ── bookings ──
  /** order.paid for a pick-up order → book a slot: next day 12:00 Lagos, or the first day with capacity. Idempotent per order. */
  async createBookingForOrder(orderId: string) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, include: { pickupBooking: true, pickupLocation: true } });
    if (!o || o.deliveryMethod !== "pickup" || !o.pickupLocation) return null;
    if (o.pickupBooking) return o.pickupBooking;
    if (!["paid", "processing"].includes(o.status)) return null;
    const loc = o.pickupLocation;
    const tomorrowNoon = new Date(lagosDayStart(new Date()).getTime() + DAY + 12 * 3_600_000);
    let scheduledAt = tomorrowNoon;
    for (let d = 0; d < 30; d++) {
      const at = new Date(tomorrowNoon.getTime() + d * DAY);
      if ((await slotsUsed(prisma, loc.id, at)) < loc.capacityPerDay) {
        scheduledAt = at;
        break;
      }
    }
    try {
      return await prisma.$transaction(async (tx) => {
        const number = formatters.pickup(await nextSequence(tx, "pickup", 2006));
        const b = await tx.pickupBooking.create({ data: { number, orderId: o.id, locationId: loc.id, scheduledAt } });
        await ordersService.addEvent(tx, o.id, "pickup_scheduled", "Pick-up booked", { detail: `${loc.name} · from ${lagosLabel(scheduledAt)}`, actor: "system" });
        return b;
      });
    } catch (err) {
      // two listeners raced: orderId is unique, keep the first booking
      if ((err as { code?: string }).code === "P2002") return prisma.pickupBooking.findUnique({ where: { orderId: o.id } });
      throw err;
    }
  },

  /** order cancelled → release its slot */
  async cancelBookingForOrder(orderId: string) {
    const b = await prisma.pickupBooking.findUnique({ where: { orderId } });
    if (!b || !["scheduled", "ready", "no_show"].includes(b.status)) return;
    await prisma.pickupBooking.update({ where: { id: b.id }, data: { status: "cancelled" } });
  },

  async listBookings(q: BookingListQuery) {
    const today = lagosDayStart(new Date());
    const todayRange = { gte: today, lt: new Date(today.getTime() + DAY) };
    const and: Prisma.PickupBookingWhereInput[] = [];
    if (q.tab === "today") and.push({ scheduledAt: todayRange, status: { in: ["scheduled", "ready"] } });
    else if (q.tab !== "all") and.push({ status: q.tab });
    if (q.locationId) and.push({ locationId: q.locationId });
    if (q.date) {
      const from = lagosDayFromIso(q.date);
      and.push({ scheduledAt: { gte: from, lt: new Date(from.getTime() + DAY) } });
    }
    if (q.q)
      and.push({
        OR: [
          { number: { contains: q.q } }, { order: { number: { contains: q.q } } }, { collectedBy: { contains: q.q } },
          { order: { customer: { OR: [{ email: { contains: q.q } }, { firstName: { contains: q.q } }, { lastName: { contains: q.q } }, { phone: { contains: q.q } }] } } },
        ],
      });
    const where: Prisma.PickupBookingWhereInput = { AND: and };
    const scope: Prisma.PickupBookingWhereInput = q.locationId ? { locationId: q.locationId } : {};
    const [rows, total, groups, todayCount, collectedToday] = await Promise.all([
      prisma.pickupBooking.findMany({ where, ...paging(q), orderBy: q.sort === "-scheduledAt" ? { scheduledAt: "desc" } : { scheduledAt: "asc" }, include: bookingInclude }),
      prisma.pickupBooking.count({ where }),
      prisma.pickupBooking.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
      prisma.pickupBooking.count({ where: { ...scope, scheduledAt: todayRange, status: { in: ["scheduled", "ready"] } } }),
      prisma.pickupBooking.count({ where: { ...scope, collectedAt: todayRange } }),
    ]);
    const c = (s: PickupStatus) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const tabs = {
      all: groups.reduce((n, g) => n + g._count._all, 0), today: todayCount,
      scheduled: c("scheduled"), ready: c("ready"), collected: c("collected"), no_show: c("no_show"), cancelled: c("cancelled"),
    };
    const kpis = { today: todayCount, readyToCollect: c("ready"), collectedToday, noShows: c("no_show") };
    return withMeta(rows.map(toAdminBooking), { ...pageMeta(q, total), tabs, kpis, labels: BOOKING_LABEL });
  },

  async getBooking(id: string) {
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] }, include: bookingInclude });
    if (!b) throw ApiError.notFound("Pick-up booking");
    return toAdminBooking(b);
  },

  async advanceBooking(id: string, body: BookingAdvanceBody, actor: string) {
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] }, include: { order: true, location: true } });
    if (!b) throw ApiError.notFound("Pick-up booking");
    if (!BOOKING_NEXT[b.status].includes(body.status))
      throw ApiError.conflict("INVALID_STATE", `Can't move a pick-up from "${BOOKING_LABEL[b.status]}" to "${BOOKING_LABEL[body.status]}".`, { allowed: BOOKING_NEXT[b.status] });
    if ((body.status === "ready" || body.status === "collected") && !["paid", "processing", "shipped", "out_for_delivery"].includes(b.order.status))
      throw ApiError.conflict("INVALID_STATE", `Order ${b.order.number} is no longer open, so it can't be handed over.`);
    const o = b.order;
    const change = await prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.pickupBooking.update({
        where: { id: b.id },
        data: {
          status: body.status,
          ...(body.note !== undefined && body.status !== "collected" ? { notes: body.note || null } : {}),
          ...(body.status === "collected"
            ? { collectedAt: now, collectedBy: body.collectedBy || b.collectedBy || "Customer", ...(body.note !== undefined ? { notes: body.note || null } : {}) }
            : body.collectedBy
              ? { collectedBy: body.collectedBy }
              : {}),
        },
      });
      if (body.status === "ready") {
        const c = await ordersService.syncFromFulfilment(tx, o.id, "processing", actor);
        await ordersService.addEvent(tx, o.id, "ready_for_pickup", "Ready for pick-up", { detail: `${b.location.name} · ${b.location.hours}`, actor });
        return c;
      }
      if (body.status === "collected") {
        await ordersService.addEvent(tx, o.id, "note", `Collected from ${b.location.name}`, { detail: `by ${body.collectedBy || b.collectedBy || "customer"}`, actor, internal: true });
        return ordersService.syncFromFulfilment(tx, o.id, "delivered", actor);
      }
      if (body.status === "no_show") await ordersService.addEvent(tx, o.id, "pickup_missed", "Pick-up missed", { detail: `${b.location.name} — contact us to arrange a new time`, actor });
      if (body.status === "cancelled") await ordersService.addEvent(tx, o.id, "pickup_cancelled", "Pick-up booking cancelled", { actor });
      return null;
    });
    if (change) events.emit("order.status_changed", { orderId: o.id, from: change.from, to: change.to });
    if (change?.to === "delivered") events.emit("order.delivered", { orderId: o.id });
    if (body.status === "ready") events.emit("pickup.ready", { bookingId: b.id });
    return this.getBooking(b.id);
  },

  async setBookingNote(id: string, note: string) {
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] } });
    if (!b) throw ApiError.notFound("Pick-up booking");
    await prisma.pickupBooking.update({ where: { id: b.id }, data: { notes: note || null } });
    return this.getBooking(b.id);
  },

  /** new day / store, respecting the store's daily capacity */
  async rescheduleBooking(id: string, body: BookingRescheduleBody, actor: string) {
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] }, include: { location: true } });
    if (!b) throw ApiError.notFound("Pick-up booking");
    if (!["scheduled", "ready", "no_show"].includes(b.status))
      throw ApiError.conflict("INVALID_STATE", `A ${BOOKING_LABEL[b.status].toLowerCase()} pick-up can't be rescheduled.`);
    if (body.scheduledAt.getTime() < lagosDayStart(new Date()).getTime())
      throw ApiError.badRequest("VALIDATION_FAILED", "Choose today or a later day.");
    const loc = body.locationId && body.locationId !== b.locationId ? await this.activeLocation(body.locationId) : b.location;
    const before = { scheduledAt: b.scheduledAt, locationId: b.locationId };
    await prisma.$transaction(async (tx) => {
      // lock the store row so two reschedules can't both take the last slot
      await tx.$queryRaw`SELECT id FROM \`PickupLocation\` WHERE id = ${loc.id} FOR UPDATE`;
      const used = await slotsUsed(tx, loc.id, body.scheduledAt, b.id);
      if (used >= loc.capacityPerDay)
        throw ApiError.conflict("INVALID_STATE", `${loc.name} is fully booked that day (${loc.capacityPerDay} pick-ups). Choose another day.`, { capacityPerDay: loc.capacityPerDay, booked: used });
      await tx.pickupBooking.update({ where: { id: b.id }, data: { scheduledAt: body.scheduledAt, locationId: loc.id, ...(b.status === "no_show" ? { status: "scheduled" } : {}) } });
      if (loc.id !== b.locationId) await tx.order.update({ where: { id: b.orderId }, data: { pickupLocationId: loc.id } });
      await ordersService.addEvent(tx, b.orderId, "pickup_scheduled", "Pick-up rescheduled", { detail: `${loc.name} · from ${lagosLabel(body.scheduledAt)}`, actor });
    });
    return { before, after: await this.getBooking(b.id) };
  },

  /** customer order tracking: booking + store */
  async customerBooking(orderId: string, location: PickupLocation | null) {
    const b = await prisma.pickupBooking.findUnique({ where: { orderId }, include: { location: true } });
    const loc = b?.location ?? location;
    return {
      number: b?.number ?? null,
      status: b?.status ?? null,
      statusLabel: b ? BOOKING_CUSTOMER_LABEL[b.status] : "Awaiting payment",
      scheduledAt: b?.scheduledAt ?? null,
      collectedAt: b?.collectedAt ?? null,
      location: loc ? { id: loc.id, name: loc.name, address: loc.address, city: loc.city, state: loc.state, phone: loc.phone, hours: loc.hours } : null,
    };
  },

  /** pickup.ready notification context */
  async readyContext(bookingId: string) {
    const b = await prisma.pickupBooking.findUnique({ where: { id: bookingId }, include: { location: true, order: { include: { customer: { select: { ...customerBrief, phone: true } } } } } });
    if (!b) logger.warn({ bookingId }, "pickup.ready for unknown booking");
    return b;
  },
};
