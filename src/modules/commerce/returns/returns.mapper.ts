import type { Prisma, ReturnStatus } from "@/generated/prisma/client";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";

export const returnInclude = {
  items: true,
  events: { orderBy: { createdAt: "asc" } },
  order: {
    select: {
      id: true, number: true, status: true, subtotal: true, discount: true, amountPaid: true, amountRefunded: true,
      walletApplied: true, placedAt: true, deliveredAt: true, items: true,
    },
  },
  customer: { select: { ...customerBrief, phone: true, tier: true } },
} satisfies Prisma.ReturnRequestInclude;
export type ReturnRow = Prisma.ReturnRequestGetPayload<{ include: typeof returnInclude }>;

/** statuses still being worked on */
export const OPEN_STATUSES: ReturnStatus[] = ["requested", "approved", "in_transit_back", "received", "under_investigation"];

const variantLabel = (i: { color: string | null; size: string | null }) => [i.color, i.size].filter(Boolean).join(" · ");

/** return lines joined with the order lines they point at */
export function returnLines(r: Pick<ReturnRow, "items" | "order">) {
  return r.items.map((ri) => {
    const oi = r.order.items.find((x) => x.id === ri.orderItemId);
    return {
      orderItemId: ri.orderItemId,
      qty: ri.qty,
      name: oi?.name ?? "Item",
      brand: oi?.brand ?? "",
      size: oi?.size ?? null,
      color: oi?.color ?? null,
      variant: oi ? variantLabel(oi) : "",
      sku: oi?.sku ?? null,
      variantId: oi?.variantId ?? null,
      image: oi?.imageUrl ?? null,
      unitPrice: oi?.unitPrice ?? 0,
      lineTotal: (oi?.unitPrice ?? 0) * ri.qty,
    };
  });
}

const lastNote = (r: Pick<ReturnRow, "events">, status: ReturnStatus) => [...r.events].reverse().find((e) => e.status === status);

/** customer cancelled their own request (stored as `rejected` by the customer) */
export const cancelledByCustomer = (r: Pick<ReturnRow, "status" | "events">) => r.status === "rejected" && lastNote(r, "rejected")?.actor === "customer";

/** the one-line explanation under the status chip on /account/returns */
export function customerStatusNote(r: Pick<ReturnRow, "status" | "events" | "refundTo">) {
  switch (r.status) {
    case "requested": return "We've received your request and are reviewing it.";
    case "approved": return "Return approved. Send the item back.";
    case "in_transit_back": return "Your return is on its way to us.";
    case "received": return "We've received your return and are inspecting it.";
    case "under_investigation": return "We're taking a closer look at your item. We'll update you shortly.";
    case "refunded": return `Refund completed to your ${r.refundTo === "wallet" ? "wallet" : "original payment method"}.`;
    case "rejected": {
      if (cancelledByCustomer(r)) return "You cancelled this return request.";
      const note = lastNote(r, "rejected")?.note;
      return note ? `Rejected: ${note}` : "Rejected.";
    }
  }
}

/** /account/returns list card (asl-web `ReturnRequest`) */
export function toCustomerReturnCard(r: ReturnRow) {
  const lines = returnLines(r);
  const first = lines[0];
  return {
    id: r.id,
    number: r.number,
    orderId: r.order.id,
    orderNumber: r.order.number,
    name: first?.name ?? "",
    detail: first ? first.variant || first.brand : "",
    size: first?.size ?? undefined,
    image: first?.image ?? null,
    itemsCount: lines.reduce((n, l) => n + l.qty, 0),
    reason: r.reason,
    status: STATUS_LABELS.return.customer[r.status],
    statusKey: r.status,
    statusNote: customerStatusNote(r),
    refundAmount: r.refundAmount,
    requestedOn: r.createdAt,
  };
}

/** /account/returns/:id */
export function toCustomerReturn(r: ReturnRow, o: { refundProcessingDays: string }) {
  return {
    ...toCustomerReturnCard(r),
    details: r.details,
    photos: (r.photos as string[] | null) ?? [],
    items: returnLines(r).map(({ sku: _s, variantId: _v, ...l }) => l),
    canCancel: r.status === "requested",
    cancelled: cancelledByCustomer(r),
    refund: {
      to: r.refundTo,
      toLabel: r.refundTo === "wallet" ? "ASL Wallet" : "Original payment method",
      amount: r.refundAmount,
      refundedAt: r.refundedAt,
      processing: r.refundTo === "wallet" ? "Instant" : o.refundProcessingDays,
    },
    timeline: r.events.map((e) => ({
      status: STATUS_LABELS.return.customer[e.status],
      statusKey: e.status,
      note: e.note,
      at: e.createdAt,
    })),
  };
}

const customerName = (r: ReturnRow) => (r.customer ? fullName(r.customer) : "Guest");

/** asl-admin /returns table row */
export function toAdminReturnRow(r: ReturnRow) {
  return {
    id: r.id,
    number: r.number,
    order: r.order.number,
    orderId: r.order.id,
    customer: r.customer ? { id: r.customer.id, name: customerName(r), email: r.customer.email } : null,
    customerName: customerName(r),
    reason: r.reason,
    items: r.items.reduce((n, i) => n + i.qty, 0),
    refund: r.refundAmount,
    refundTo: r.refundTo,
    status: STATUS_LABELS.return.admin[r.status],
    statusKey: r.status,
    restocked: r.restocked,
    requested: r.createdAt,
    refundedAt: r.refundedAt,
  };
}

/** what the admin can do next from each status (drives the drawer buttons) */
export const ADMIN_ACTIONS: Record<ReturnStatus, string[]> = {
  requested: ["approve", "reject", "investigate"],
  approved: ["in-transit", "received", "investigate", "reject", "refund"],
  in_transit_back: ["received", "investigate", "reject", "refund"],
  received: ["investigate", "reject", "refund"],
  under_investigation: ["approve", "received", "reject", "refund"],
  refunded: [],
  rejected: [],
};

export function toAdminReturn(r: ReturnRow, x: { suggestedRefund: number; refundable: number }) {
  return {
    ...toAdminReturnRow(r),
    customer: r.customer ? { id: r.customer.id, name: customerName(r), email: r.customer.email, phone: r.customer.phone, tier: r.customer.tier } : null,
    details: r.details,
    photos: (r.photos as string[] | null) ?? [],
    inspectorNote: r.inspectorNote,
    lines: returnLines(r),
    orderSummary: {
      id: r.order.id, number: r.order.number, status: STATUS_LABELS.order.admin[r.order.status], statusKey: r.order.status,
      placedAt: r.order.placedAt, deliveredAt: r.order.deliveredAt, amountPaid: r.order.amountPaid, amountRefunded: r.order.amountRefunded,
    },
    suggestedRefund: x.suggestedRefund,
    /** still refundable on the order */
    refundable: x.refundable,
    actions: ADMIN_ACTIONS[r.status],
    timeline: r.events.map((e) => ({ status: STATUS_LABELS.return.admin[e.status], statusKey: e.status, note: e.note, actor: e.actor, at: e.createdAt })),
  };
}
