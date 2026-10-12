import type { ConciergeQuote, ConciergeQuoteLine } from "@/generated/prisma/client";

export type QuoteRow = ConciergeQuote & { lines: ConciergeQuoteLine[] };

/** sent quotes past their expiry count as expired even before the job has run */
export const effectiveStatus = (q: Pick<ConciergeQuote, "status" | "expiresAt" | "amountPaid">, now = Date.now()) =>
  (q.status === "sent" || q.status === "accepted") && q.amountPaid === 0 && q.expiresAt.getTime() <= now ? "expired" : q.status;

export const balanceDue = (q: Pick<ConciergeQuote, "status" | "total" | "amountPaid">) =>
  q.status === "paid" ? Math.max(0, q.total - q.amountPaid) : 0;

/** what the customer pays next: the deposit, or the balance once the deposit is in */
export const amountDueNow = (q: Pick<ConciergeQuote, "status" | "total" | "amountPaid" | "deposit">) =>
  q.status === "paid" ? Math.max(0, q.total - q.amountPaid) : q.deposit;

export function toQuote(q: QuoteRow) {
  const status = effectiveStatus(q);
  return {
    id: q.id,
    number: q.number,
    status,
    lines: q.lines.map((l) => ({ id: l.id, name: l.name, source: l.source, qty: l.qty, price: l.price, total: l.price * l.qty })),
    itemsTotal: q.itemsTotal,
    serviceFee: q.serviceFee,
    shippingEstimate: q.shippingEstimate,
    tax: q.tax,
    taxIncluded: q.taxIncluded,
    total: q.total,
    depositPct: q.depositPct,
    deposit: q.deposit,
    amountPaid: q.amountPaid,
    balanceDue: balanceDue(q),
    amountDueNow: status === "sent" || status === "accepted" || (status === "paid" && balanceDue(q) > 0) ? amountDueNow(q) : 0,
    expiresAt: q.expiresAt,
    expired: status === "expired",
    note: q.note,
    declineReason: q.declineReason,
    acceptedAt: q.acceptedAt,
    paidAt: q.paidAt,
    createdAt: q.createdAt,
  };
}

/** chat quote card / inbox summary */
export const quoteBrief = (q: QuoteRow | ConciergeQuote) => ({
  id: q.id, number: q.number, status: effectiveStatus(q), total: q.total, deposit: q.deposit, depositPct: q.depositPct,
  amountPaid: q.amountPaid, expiresAt: q.expiresAt,
});
