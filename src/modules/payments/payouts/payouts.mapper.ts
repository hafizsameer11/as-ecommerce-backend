import type { Payout, PayoutLine, PayoutStatus } from "@/generated/prisma/client";

/** asl-admin PAYOUT_STATUS_META wording */
export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  scheduled: "Scheduled", in_transit: "In transit", paid: "Paid", failed: "Failed", on_hold: "On hold",
};

const PROVIDER_LABEL: Record<string, string> = { paystack: "Paystack", flutterwave: "Flutterwave", stripe: "Stripe", manual: "Manual Bank", mock: "Mock gateway" };
export const providerLabel = (p: string) => PROVIDER_LABEL[p.toLowerCase()] ?? p;

export const toPayoutLine = (l: PayoutLine) => ({
  id: l.id, paymentRef: l.paymentRef, orderNumber: l.orderNumber, gross: l.gross, fee: l.fee, net: l.net, capturedAt: l.capturedAt,
});

export const toPayout = (p: Payout & { lines?: PayoutLine[]; _count?: { lines: number } }) => ({
  id: p.id,
  number: p.number,
  provider: p.provider,
  providerLabel: providerLabel(p.provider),
  reference: p.reference,
  status: p.status,
  statusLabel: PAYOUT_STATUS_LABEL[p.status],
  currency: "NGN",
  gross: p.gross,
  fees: p.fees,
  refunds: p.refunds,
  adjustments: p.adjustments,
  net: p.net,
  bankName: p.bankName,
  bankAccountMasked: p.bankAccountMasked,
  bankAccountName: p.bankAccountName,
  scheduledAt: p.scheduledAt,
  paidAt: p.paidAt,
  txnCount: p._count?.lines ?? p.lines?.length ?? 0,
  notes: p.notes,
  failureReason: p.failureReason,
  createdAt: p.createdAt,
  ...(p.lines ? { transactions: p.lines.map(toPayoutLine) } : {}),
});
