import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { fullName } from "@/modules/identity/auth/customer.mapper";

export const orderInclude = {
  items: true,
  events: { orderBy: { createdAt: "asc" } },
  payments: { orderBy: { createdAt: "desc" } },
  shipments: { orderBy: { createdAt: "desc" }, select: { number: true, carrier: true, trackingNumber: true, status: true, etaAt: true } },
  pickupLocation: true,
  couponRedemptions: { select: { code: true, discount: true } },
} satisfies Prisma.OrderInclude;
export type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export const listInclude = {
  items: { select: { name: true, brand: true, imageUrl: true, qty: true, size: true, color: true, unitPrice: true } },
  shipments: { orderBy: { createdAt: "desc" }, take: 1, select: { carrier: true, trackingNumber: true, etaAt: true } },
  customer: { select: { id: true, firstName: true, lastName: true, email: true, tier: true } },
} satisfies Prisma.OrderInclude;
export type OrderListRow = Prisma.OrderGetPayload<{ include: typeof listInclude }>;

/** statuses the customer can still cancel from (before it leaves the warehouse) */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = ["pending_payment", "paid"];
const IN_TRANSIT: OrderStatus[] = ["shipped", "out_for_delivery"];

const variantLabel = (i: { color: string | null; size: string | null }) => [i.color, i.size].filter(Boolean).join(" · ");

function tracking(o: { shipments: { carrier: string; trackingNumber: string | null; etaAt: Date | null }[] }) {
  const s = o.shipments[0];
  return s?.trackingNumber ? `${s.carrier}-${s.trackingNumber}` : null;
}

/** account orders list card (the apps' `Order` type) */
export function toCustomerOrderCard(o: OrderListRow) {
  return {
    id: o.id,
    number: o.number,
    date: o.placedAt,
    status: STATUS_LABELS.order.customer[o.status],
    statusKey: o.status,
    paymentStatus: o.paymentStatus,
    total: o.total,
    itemsCount: o.items.reduce((n, i) => n + i.qty, 0),
    eta: o.shipments[0]?.etaAt ?? o.expectedDeliveryAt,
    tracking: tracking(o),
    items: o.items.map((i) => ({ name: i.name, brand: i.brand, variant: variantLabel(i), qty: i.qty, price: i.unitPrice, image: i.imageUrl })),
  };
}

/** order detail + tracking timeline */
export function toCustomerOrder(o: OrderRow, opts: { returnWindowDays: number }) {
  const due = Math.max(0, o.total - o.amountPaid);
  const deliveredAgo = o.deliveredAt ? (Date.now() - o.deliveredAt.getTime()) / 86_400_000 : null;
  return {
    id: o.id,
    number: o.number,
    date: o.placedAt,
    status: STATUS_LABELS.order.customer[o.status],
    statusKey: o.status,
    paymentStatus: o.paymentStatus,
    items: o.items.map((i) => ({
      id: i.id, productId: i.productId, name: i.name, brand: i.brand, variant: variantLabel(i), size: i.size, color: i.color,
      qty: i.qty, price: i.unitPrice, lineTotal: i.lineTotal, image: i.imageUrl, qtyReturned: i.qtyReturned,
    })),
    itemsCount: o.items.reduce((n, i) => n + i.qty, 0),
    subtotal: o.subtotal,
    discount: o.discount,
    couponCode: o.couponCode,
    coupons: o.couponRedemptions,
    shipping: o.shipping,
    shippingMethod: o.shippingRateName,
    tax: o.tax,
    total: o.total,
    walletApplied: o.walletApplied,
    amountPaid: o.amountPaid,
    amountRefunded: o.amountRefunded,
    due,
    delivery: o.deliveryMethod,
    payment: o.paymentMethod,
    contact: o.contact,
    address: o.shippingAddress,
    pickupLocation: o.pickupLocation ? { id: o.pickupLocation.id, name: o.pickupLocation.name, address: o.pickupLocation.address, hours: o.pickupLocation.hours, phone: o.pickupLocation.phone } : null,
    giftMessage: o.giftMessage,
    eta: o.shipments[0]?.etaAt ?? o.expectedDeliveryAt,
    tracking: tracking(o),
    shipments: o.shipments,
    timeline: o.events.filter((e) => !e.internal).map((e) => ({ type: e.type, title: e.title, detail: e.detail, at: e.createdAt })),
    canCancel: CUSTOMER_CANCELLABLE.includes(o.status),
    canPay: o.status === "pending_payment" && due > 0,
    canReturn: o.status === "delivered" && deliveredAgo !== null && deliveredAgo <= opts.returnWindowDays,
    inTransit: IN_TRANSIT.includes(o.status),
  };
}

/** asl-admin /orders table row */
export function toAdminOrderRow(o: OrderListRow) {
  const contact = o.contact as { email?: string; phone?: string };
  return {
    id: o.id,
    number: o.number,
    placedAt: o.placedAt,
    customer: o.customer ? { id: o.customer.id, name: fullName(o.customer), email: o.customer.email, tier: o.customer.tier } : { id: null, name: "Guest", email: o.guestEmail ?? contact.email ?? null, tier: null },
    channel: o.channel,
    status: o.status,
    statusLabel: STATUS_LABELS.order.admin[o.status],
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    deliveryMethod: o.deliveryMethod,
    itemsCount: o.items.reduce((n, i) => n + i.qty, 0),
    total: o.total,
    amountPaid: o.amountPaid,
    tracking: tracking(o),
  };
}

export function toAdminOrder(o: OrderRow & { customer: { id: string; name: string; email: string; phone: string | null; tier: string } | null; notes: { id: string; author: string; body: string; createdAt: Date }[] }) {
  return {
    ...toCustomerOrder(o, { returnWindowDays: 0 }),
    status: o.status,
    statusLabel: STATUS_LABELS.order.admin[o.status],
    channel: o.channel,
    customer: o.customer,
    guestEmail: o.guestEmail,
    cancelReason: o.cancelReason,
    paidAt: o.paidAt,
    cancelledAt: o.cancelledAt,
    deliveredAt: o.deliveredAt,
    payments: o.payments.map((p) => ({ id: p.id, reference: p.reference, method: p.method, status: p.status, amount: p.amount, fee: p.fee, amountRefunded: p.amountRefunded, paidAt: p.paidAt, createdAt: p.createdAt })),
    events: o.events.map((e) => ({ id: e.id, type: e.type, title: e.title, detail: e.detail, actor: e.actor, internal: e.internal, at: e.createdAt })),
    notes: o.notes,
  };
}
