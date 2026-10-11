import type { Carrier, Prisma, ShipmentStatus } from "@/generated/prisma/client";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";

export const CARRIER_LABEL: Record<Carrier, string> = {
  DHL: "DHL", FedEx: "FedEx", UPS: "UPS", GIG: "GIG Logistics", Aramex: "Aramex", Local: "Local", InHouse: "In-house",
};

/** admin wording (asl-admin STATUS_META) */
export const SHIPMENT_LABEL: Record<ShipmentStatus, string> = {
  label_created: "Label created",
  picked_up: "Picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Exception",
  returned: "Returned",
};

/** customer tracking timeline wording */
export const SHIPMENT_CUSTOMER_LABEL: Record<ShipmentStatus, string> = {
  label_created: "Preparing shipment",
  picked_up: "Picked up by courier",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Delivery delayed",
  returned: "Returned to sender",
};

export const shipmentInclude = {
  events: { orderBy: { createdAt: "asc" } },
  order: { select: { id: true, number: true, contact: true, guestEmail: true, shippingAddress: true, customer: { select: { ...customerBrief, phone: true } } } },
} satisfies Prisma.ShipmentInclude;
export type ShipmentRow = Prisma.ShipmentGetPayload<{ include: typeof shipmentInclude }>;

type Contact = { email?: string; phone?: string };
type Address = { fullName?: string; city?: string; state?: string; country?: string };

export function customerOf(o: { customer: { firstName: string; lastName: string; email: string; phone?: string | null } | null; contact: unknown; guestEmail: string | null; shippingAddress: unknown }) {
  const c = (o.contact ?? {}) as Contact;
  const a = (o.shippingAddress ?? {}) as Address;
  return {
    name: o.customer ? fullName(o.customer) : a.fullName || "Guest",
    email: c.email ?? o.customer?.email ?? o.guestEmail ?? null,
    phone: c.phone || o.customer?.phone || null,
  };
}

/** asl-admin Shipment */
export function toAdminShipment(s: ShipmentRow, warehouses: Map<string, { name: string; city: string }>) {
  const wh = s.originWarehouseId ? warehouses.get(s.originWarehouseId) : undefined;
  return {
    id: s.id,
    number: s.number,
    orderId: s.order.id,
    orderNumber: s.order.number,
    customerName: customerOf(s.order).name,
    carrier: s.carrier,
    carrierLabel: CARRIER_LABEL[s.carrier],
    service: s.service,
    tracking: s.trackingNumber,
    status: s.status,
    statusLabel: SHIPMENT_LABEL[s.status],
    origin: wh ? `${wh.city}` : null,
    warehouseId: s.originWarehouseId,
    warehouseName: wh?.name ?? null,
    destination: s.destination,
    weightKg: s.weightKg,
    itemsCount: s.itemsCount,
    declaredValue: s.declaredValue,
    cost: s.cost,
    insured: s.insured,
    signatureRequired: s.signatureRequired,
    notes: s.notes,
    createdAt: s.createdAt,
    shippedAt: s.shippedAt,
    etaAt: s.etaAt,
    deliveredAt: s.deliveredAt,
    events: s.events.map((e) => ({ id: e.id, at: e.createdAt, status: e.status, label: SHIPMENT_LABEL[e.status], location: e.location, note: e.note })),
  };
}

/** customer tracking card */
export function toCustomerShipment(s: { number: string; carrier: Carrier; service: string; trackingNumber: string | null; status: ShipmentStatus; etaAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null; events: { status: ShipmentStatus; location: string; note: string | null; createdAt: Date }[] }) {
  return {
    number: s.number,
    carrier: s.carrier,
    carrierLabel: CARRIER_LABEL[s.carrier],
    service: s.service,
    trackingNumber: s.trackingNumber,
    status: s.status,
    statusLabel: SHIPMENT_CUSTOMER_LABEL[s.status],
    eta: s.etaAt,
    shippedAt: s.shippedAt,
    deliveredAt: s.deliveredAt,
    events: [...s.events].reverse().map((e) => ({ status: e.status, label: SHIPMENT_CUSTOMER_LABEL[e.status], location: e.location, note: e.note, at: e.createdAt })),
  };
}
