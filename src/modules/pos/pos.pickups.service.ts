import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { BOOKING_LABEL, pickupsService } from "@/modules/fulfilment/pickups/pickups.service";
import { posOutboundService } from "./pos.outbound.service";
import type { CollectPickupBody, PickupsQuery } from "./pos.schemas";

type Staff = { id: string; name: string };

const include = {
  location: { select: { id: true, name: true, hours: true, phone: true } },
  order: {
    select: {
      id: true,
      number: true,
      status: true,
      contact: true,
      guestEmail: true,
      customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
      items: { select: { name: true, brand: true, qty: true, size: true, color: true, imageUrl: true, sku: true } },
    },
  },
} satisfies Prisma.PickupBookingInclude;

function mapBooking(b: Prisma.PickupBookingGetPayload<{ include: typeof include }>) {
  const contact = (b.order.contact ?? {}) as { email?: string; phone?: string; name?: string };
  return {
    id: b.id,
    number: b.number,
    pickupCode: b.pickupCode,
    status: b.status,
    statusLabel: BOOKING_LABEL[b.status],
    scheduledAt: b.scheduledAt,
    locationId: b.locationId,
    locationName: b.location.name,
    locationHours: b.location.hours,
    orderId: b.order.id,
    orderNumber: b.order.number,
    orderStatus: b.order.status,
    customerName: b.order.customer ? fullName(b.order.customer) : contact.name || "Guest",
    customerEmail: contact.email ?? b.order.customer?.email ?? b.order.guestEmail ?? null,
    customerPhone: contact.phone || b.order.customer?.phone || null,
    items: b.order.items,
    itemsCount: b.order.items.reduce((n, i) => n + i.qty, 0),
    notes: b.notes,
    collectedAt: b.collectedAt,
    collectedBy: b.collectedBy,
  };
}

export const posPickupsService = {
  async list(q: PickupsQuery, staffLocationIds: string[]) {
    const locationId = q.locationId;
    if (locationId && staffLocationIds.length && !staffLocationIds.includes(locationId)) {
      throw ApiError.forbidden("You can't view pickups for that boutique.");
    }
    const where: Prisma.PickupBookingWhereInput = {
      ...(locationId ? { locationId } : staffLocationIds.length ? { locationId: { in: staffLocationIds } } : {}),
      ...(q.status ? { status: q.status } : { status: { in: ["scheduled", "ready"] } }),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q } },
              { pickupCode: { contains: q.q } },
              { order: { number: { contains: q.q } } },
              { collectedBy: { contains: q.q } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.pickupBooking.findMany({ where, include, orderBy: [{ status: "asc" }, { scheduledAt: "asc" }], ...paging(q) }),
      prisma.pickupBooking.count({ where }),
    ]);
    return withMeta(rows.map(mapBooking), pageMeta(q, total));
  },

  async markReady(id: string, staff: Staff) {
    const before = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] }, include });
    if (!before) throw ApiError.notFound("Pickup");
    if (!before.pickupCode) {
      await prisma.pickupBooking.update({
        where: { id: before.id },
        data: { pickupCode: String(Math.floor(100000 + Math.random() * 900000)) },
      });
    }
    await pickupsService.advanceBooking(before.id, { status: "ready", collectedBy: undefined, note: undefined }, staff.name);
    const b = await prisma.pickupBooking.findUniqueOrThrow({ where: { id: before.id }, include });
    const mapped = mapBooking(b);

    const phone = mapped.customerPhone;
    const email = mapped.customerEmail;
    if (phone) {
      await posOutboundService.enqueue({
        channel: "sms",
        template: "pickup.ready",
        to: phone,
        orderId: b.orderId,
        bookingId: b.id,
        staffId: staff.id,
        payload: {
          orderNumber: mapped.orderNumber,
          pickupCode: mapped.pickupCode,
          store: mapped.locationName,
          hours: mapped.locationHours,
        },
      });
      await posOutboundService.enqueue({
        channel: "whatsapp",
        template: "pickup.ready",
        to: phone,
        orderId: b.orderId,
        bookingId: b.id,
        staffId: staff.id,
        payload: {
          orderNumber: mapped.orderNumber,
          pickupCode: mapped.pickupCode,
          store: mapped.locationName,
          hours: mapped.locationHours,
        },
      });
    }
    if (email) {
      await posOutboundService.enqueue({
        channel: "email",
        template: "pickup.ready",
        to: email,
        orderId: b.orderId,
        bookingId: b.id,
        staffId: staff.id,
        payload: {
          orderNumber: mapped.orderNumber,
          pickupCode: mapped.pickupCode,
          store: mapped.locationName,
          hours: mapped.locationHours,
        },
      });
    }

    await prisma.posAuditEvent.create({
      data: {
        locationId: b.locationId,
        staffId: staff.id,
        action: "sale",
        text: `${staff.name} marked pickup ${b.number} ready (code ${mapped.pickupCode})`,
        ref: b.number,
      },
    });

    return mapped;
  },

  async collect(id: string, body: CollectPickupBody, staff: Staff) {
    const pos = await settingsService.get("pos");
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] }, include });
    if (!b) throw ApiError.notFound("Pickup");
    if (b.status === "collected") throw ApiError.conflict("INVALID_STATE", "Already collected.");
    if (b.status === "cancelled") throw ApiError.conflict("INVALID_STATE", "This pickup was cancelled.");

    if (body.offline && !pos.pickupsOffline) {
      throw ApiError.conflict("INVALID_STATE", "Pickups can't be handed over while offline.");
    }

    if (b.pickupCode) {
      if (body.code) {
        if (body.code.trim() !== b.pickupCode) throw ApiError.badRequest("VALIDATION_FAILED", "That pickup code isn't right.");
      } else if (!body.idChecked) {
        throw ApiError.badRequest("VALIDATION_FAILED", "Enter the 6-digit pickup code, or confirm an ID check.");
      }
    } else if (!body.idChecked && !body.collectedBy) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Confirm who collected this order (ID check).");
    }

    await pickupsService.advanceBooking(
      b.id,
      { status: "collected", collectedBy: body.collectedBy || staff.name, note: body.idChecked ? "ID verified at till" : body.note },
      staff.name,
    );

    const updated = await prisma.pickupBooking.findUniqueOrThrow({ where: { id: b.id }, include });
    const mapped = mapBooking(updated);

    await posOutboundService.enqueue({
      channel: "push",
      template: "pickup.collected",
      to: mapped.customerEmail || mapped.customerPhone || "unknown",
      orderId: b.orderId,
      bookingId: b.id,
      staffId: staff.id,
      payload: { orderNumber: mapped.orderNumber, store: mapped.locationName },
    });

    await prisma.posAuditEvent.create({
      data: {
        locationId: b.locationId,
        staffId: staff.id,
        action: "sale",
        text: `${staff.name} handed over pickup ${b.number} (${mapped.orderNumber})`,
        ref: b.number,
      },
    });

    return mapped;
  },

  /** Ensure older bookings get a code when first seen at the till */
  async ensureCode(id: string) {
    const b = await prisma.pickupBooking.findFirst({ where: { OR: [{ id }, { number: id }] } });
    if (!b) throw ApiError.notFound("Pickup");
    if (b.pickupCode) return b.pickupCode;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.pickupBooking.update({ where: { id: b.id }, data: { pickupCode: code } });
    return code;
  },
};
