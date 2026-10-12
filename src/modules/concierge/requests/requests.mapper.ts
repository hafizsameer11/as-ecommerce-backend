import type { ConciergeStatus, Prisma } from "@/generated/prisma/client";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";
import { slaLevel } from "../concierge.common";
import { quoteBrief, toQuote, effectiveStatus } from "../quotes/quotes.mapper";

export const requestInclude = {
  images: { orderBy: { createdAt: "asc" } },
  timeline: { orderBy: { createdAt: "asc" } },
  quotes: { orderBy: { createdAt: "desc" }, include: { lines: true } },
  thread: true,
  customer: { select: { ...customerBrief, phone: true, tier: true } },
  supplier: { select: { id: true, name: true, tier: true, country: true } },
} satisfies Prisma.ConciergeRequestInclude;
export type RequestRow = Prisma.ConciergeRequestGetPayload<{ include: typeof requestInclude }>;

/** the quote the customer acts on: the newest one */
export const currentQuote = (r: Pick<RequestRow, "quotes">) => r.quotes[0] ?? null;

/** index into the /track-request steps (received … delivered); null when cancelled */
const TRACK_STEP: Record<ConciergeStatus, number | null> = {
  new: 0, sourcing: 2, quoted: 4, payment_pending: 5, approved: 6, ordered: 7, in_transit: 8, delivered: 9, cancelled: null, unavailable: null,
};

/** one-liner under the status chip (account requests + concierge cart) */
function statusNote(r: Pick<RequestRow, "status" | "quotes">) {
  const q = currentQuote(r);
  switch (r.status) {
    case "new": return "We've received your request.";
    case "sourcing": return "Our concierge team is finding the best option for you.";
    case "quoted": return "Your quote is ready. Review and pay to secure the item.";
    case "payment_pending": return "Awaiting payment confirmation to purchase.";
    case "approved": return q && q.amountPaid < q.total ? "Deposit received. Balance is due before dispatch." : "Item found. We'll purchase once payment is confirmed.";
    case "ordered": return "Your order has been confirmed. We're preparing it for shipment.";
    case "in_transit": return "Your order is on the way to you.";
    case "delivered": return "Delivered. Enjoy!";
    case "cancelled": return "This request was cancelled.";
    case "unavailable": return "Sorry, we couldn't source this item.";
  }
}

const labels = (s: ConciergeStatus) => ({
  status: STATUS_LABELS.concierge.customer[s],
  cartStatus: STATUS_LABELS.concierge.cart[s],
  statusKey: s,
});

const image = (r: Pick<RequestRow, "images">, productImage?: string | null) => r.images[0]?.url ?? productImage ?? null;

/** /account/requests card + concierge cart line */
export function toCustomerCard(r: RequestRow, productImage?: string | null) {
  const q = currentQuote(r);
  return {
    id: r.id,
    number: r.number,
    source: r.source,
    productId: r.productId,
    itemName: r.itemName,
    brand: r.brand,
    category: r.category,
    size: r.size,
    color: r.color,
    condition: r.condition,
    qty: r.qty,
    image: image(r, productImage),
    ...labels(r.status),
    statusNote: statusNote(r),
    /** cart "Est. Price": quoted items total, else the catalogue price / budget */
    price: q && effectiveStatus(q) !== "expired" && q.status !== "declined" ? q.itemsTotal : (r.price ?? r.budget ?? null),
    quote: q ? quoteBrief(q) : null,
    unread: r.thread?.unreadCustomer ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const publicTimeline = (r: Pick<RequestRow, "timeline">) =>
  r.timeline.filter((t) => !t.internal).map((t) => ({ id: t.id, kind: t.kind, text: t.text, by: t.by, at: t.createdAt }));

/** request detail for the owner */
export function toCustomerRequest(r: RequestRow, productImage?: string | null) {
  const q = currentQuote(r);
  return {
    ...toCustomerCard(r, productImage),
    reference: r.reference,
    description: r.description,
    budget: r.budget,
    preferredSource: r.preferredSource,
    notes: r.notes,
    images: r.images.map((i) => i.url),
    contact: { name: r.contactName, email: r.contactEmail, phone: r.contactPhone },
    deliveryAddress: r.deliveryAddress,
    trackStep: TRACK_STEP[r.status],
    timeline: publicTimeline(r),
    currentQuote: q ? toQuote(q) : null,
    canCancel: ["new", "sourcing", "quoted", "payment_pending"].includes(r.status) && !r.quotes.some((x) => x.amountPaid > 0),
    cancelledAt: r.cancelledAt,
  };
}

/** /track-request (public: no contact details, no internal notes) */
export function toTracking(r: RequestRow, productImage?: string | null) {
  const q = currentQuote(r);
  return {
    number: r.number,
    itemName: r.itemName,
    brand: r.brand,
    category: r.category,
    size: r.size,
    color: r.color,
    image: image(r, productImage),
    ...labels(r.status),
    statusNote: statusNote(r),
    trackStep: TRACK_STEP[r.status],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    timeline: publicTimeline(r),
    quote: q ? quoteBrief(q) : null,
  };
}

type Names = Map<string, string>;
const who = (r: RequestRow) =>
  r.customer
    ? { id: r.customer.id, name: fullName(r.customer), email: r.customer.email, phone: r.customer.phone, tier: r.customer.tier, guest: false }
    : { id: null, name: r.contactName, email: r.contactEmail, phone: r.contactPhone, tier: null, guest: true };

/** inbox row / board card */
export function toAdminRow(r: RequestRow, names: Names, cfg: SettingsOf<"concierge">) {
  const q = currentQuote(r);
  const level = slaLevel(r, cfg);
  return {
    id: r.id,
    number: r.number,
    source: r.source,
    customer: who(r),
    category: r.category,
    brand: r.brand,
    itemName: r.itemName,
    size: r.size,
    color: r.color,
    budget: r.budget,
    status: r.status,
    statusLabel: STATUS_LABELS.concierge.admin[r.status],
    priority: r.priority,
    assignee: r.assigneeId ? { id: r.assigneeId, name: names.get(r.assigneeId) ?? "Unknown" } : null,
    supplier: r.supplier,
    slaDueAt: r.slaDueAt,
    sla: level,
    slaBreached: level === "breached",
    quote: q ? quoteBrief(q) : null,
    /** pipeline value: live quote total, else budget / catalogue price */
    value: q && !["expired", "declined"].includes(effectiveStatus(q)) ? q.total : (r.budget ?? (r.price ? r.price * r.qty : 0)),
    unread: r.thread?.unreadAgent ?? 0,
    image: r.images[0]?.url ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toAdminRequest(r: RequestRow, names: Names, cfg: SettingsOf<"concierge">) {
  return {
    ...toAdminRow(r, names, cfg),
    productId: r.productId,
    reference: r.reference,
    description: r.description,
    condition: r.condition,
    preferredSource: r.preferredSource,
    notes: r.notes,
    qty: r.qty,
    price: r.price,
    images: r.images.map((i) => i.url),
    contact: { name: r.contactName, email: r.contactEmail, phone: r.contactPhone },
    deliveryAddress: r.deliveryAddress,
    customerStatus: STATUS_LABELS.concierge.customer[r.status],
    cartStatus: STATUS_LABELS.concierge.cart[r.status],
    timeline: r.timeline.map((t) => ({ id: t.id, kind: t.kind, text: t.text, by: t.by, internal: t.internal, at: t.createdAt })),
    quotes: r.quotes.map(toQuote),
    thread: r.thread ? { id: r.thread.id, pinned: r.thread.pinned, unread: r.thread.unreadAgent, lastAt: r.thread.lastAt } : null,
    cancelledAt: r.cancelledAt,
  };
}
