import type { DraftOrder, DraftOrderStatus } from "@/generated/prisma/client";
import { env } from "@/config/env";

/** one line as stored in DraftOrder.items (Json) */
export type DraftLine = {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  brand: string;
  size: string | null;
  color: string | null;
  qty: number;
  unitPrice: number;
  imageUrl: string | null;
  /** true = typed in by staff, not a catalogue item (no stock) */
  custom: boolean;
};

/** asl-admin /drafts wording */
export const DRAFT_LABELS: Record<DraftOrderStatus, string> = { draft: "Draft", sent: "Sent to customer", converted: "Converted" };

export const payUrl = (token: string) => `${env.WEB_URL.replace(/\/$/, "")}/pay/${token}`;
export const linesOf = (d: Pick<DraftOrder, "items">) => (d.items ?? []) as unknown as DraftLine[];

type Row = DraftOrder & { customer?: { id: string; firstName: string; lastName: string; email: string } | null; order?: { id: string; number: string } | null };

const lineView = (l: DraftLine) => ({ ...l, lineTotal: l.unitPrice * l.qty, variant: [l.color, l.size].filter(Boolean).join(" · ") });

export function toAdminDraft(d: Row) {
  const lines = linesOf(d);
  const expired = !!d.expiresAt && d.expiresAt < new Date();
  return {
    id: d.id,
    number: d.number,
    customer: d.customer ? { id: d.customer.id, name: `${d.customer.firstName} ${d.customer.lastName}`.trim(), email: d.customer.email } : null,
    customerId: d.customerId,
    customerName: d.customerName,
    email: d.email,
    itemsCount: lines.reduce((n, l) => n + l.qty, 0),
    image: lines.find((l) => l.imageUrl)?.imageUrl ?? null,
    items: lines.map(lineView),
    subtotal: d.subtotal,
    discount: d.discount,
    shipping: d.shipping,
    total: d.total,
    status: d.status,
    statusLabel: DRAFT_LABELS[d.status],
    note: d.note,
    payUrl: d.payToken && d.status === "sent" ? payUrl(d.payToken) : null,
    expiresAt: d.expiresAt,
    linkExpired: d.status === "sent" && expired,
    sentAt: d.sentAt,
    orderId: d.orderId,
    orderNumber: d.order?.number ?? null,
    createdBy: d.createdBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

/** what the customer sees on /pay/:token */
export function toPayView(d: DraftOrder, store: { name: string; supportEmail: string }) {
  return {
    number: d.number,
    customerName: d.customerName,
    email: d.email,
    items: linesOf(d).map(({ name, brand, size, color, qty, unitPrice, imageUrl }) => ({
      name, brand, size, color, qty, unitPrice, imageUrl, lineTotal: unitPrice * qty, variant: [color, size].filter(Boolean).join(" · "),
    })),
    subtotal: d.subtotal,
    discount: d.discount,
    shipping: d.shipping,
    total: d.total,
    currency: "NGN",
    expiresAt: d.expiresAt,
    store,
  };
}
