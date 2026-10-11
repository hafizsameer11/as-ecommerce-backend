/**
 * Automatic journals (chart of accounts seeded in prisma/seed/reference.ts):
 *   1000 cash at bank · 1010 payment-provider clearing · 2000 customer wallets · 2100 VAT payable
 *   4000 product sales · 4100 shipping income · 5100 payment fees · 5300 marketing & rewards
 * Each listener is idempotent (postOnce by source + reference, or delta-based for refunds).
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { logger } from "@/core/utils/logger";
import { ledgerService, SYSTEM_USER } from "./ledger.service";
import type { LineInput } from "./ledger.schemas";

export const ACC = {
  bank: "1000",
  clearing: "1010",
  wallets: "2000",
  vat: "2100",
  sales: "4000",
  shipping: "4100",
  fees: "5100",
  rewards: "5300",
} as const;

const dr = (accountCode: string, amount: number, memo?: string): LineInput => ({ accountCode, debit: amount, credit: 0, memo });
const cr = (accountCode: string, amount: number, memo?: string): LineInput => ({ accountCode, debit: 0, credit: amount, memo });
/** drop zero lines */
const nz = (lines: LineInput[]) => lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);

/** order.paid: Dr clearing (card/transfer) + Dr wallets / Cr sales, shipping, VAT */
export async function journalOrderPaid(orderId: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: { where: { status: { in: ["succeeded", "partially_refunded", "refunded"] } } } } });
  if (!o || o.amountPaid <= 0) return null;
  const products = o.subtotal - o.discount;
  const ship = o.shipping;
  // VAT inside the prices, split between goods and delivery in proportion
  const vatShip = products + ship > 0 ? Math.round((o.taxIncluded * ship) / (products + ship)) : 0;
  const vatProducts = o.taxIncluded - vatShip;
  const vat = o.taxIncluded + o.tax;
  let sales = products - vatProducts;
  const shipIncome = ship - vatShip;

  const wallet = Math.min(o.walletApplied, o.amountPaid);
  const outside = o.amountPaid - wallet;
  // payments confirmed by hand (bank transfer to our account, POS, cash) never pass the provider
  const manual = Math.min(outside, o.payments.filter((p) => p.provider === "manual").reduce((n, p) => n + p.amount, 0));
  const clearing = outside - manual;
  // rounding remainder (and any over/under payment) lands on product sales so the journal balances to the kobo
  sales += o.amountPaid - (sales + shipIncome + vat);

  const entry = await ledgerService.postOnce("order", o.number, {
    date: o.paidAt ?? new Date(),
    description: `Order paid · ${o.number}`,
    createdBy: SYSTEM_USER,
    lines: nz([
      dr(ACC.clearing, clearing, "Card / transfer via provider"),
      dr(ACC.bank, manual, "Paid directly to bank"),
      dr(ACC.wallets, wallet, "ASL Wallet"),
      cr(ACC.sales, sales, "Product revenue"),
      cr(ACC.shipping, shipIncome, "Delivery"),
      cr(ACC.vat, vat, "VAT"),
    ]),
  });
  // a refund/cancel event may have run before this journal existed → catch up now
  if (entry) await journalOrderRefund(orderId);
  return entry;
}

/** payment.succeeded: wallet top-ups (Dr clearing / Cr wallets) and provider fees (Dr fees / Cr clearing) */
export async function journalPayment(paymentId: string) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) return;
  const date = p.paidAt ?? new Date();
  const cash = p.provider === "manual" ? ACC.bank : ACC.clearing;
  if (p.purpose === "wallet_topup")
    await ledgerService.postOnce("wallet", p.reference, {
      date, description: `Wallet top-up · ${p.email}`, createdBy: SYSTEM_USER,
      lines: [dr(cash, p.amount, p.provider), cr(ACC.wallets, p.amount, "Customer wallet")],
    });
  if (p.fee > 0)
    await ledgerService.postOnce("fee", p.reference, {
      date, description: `Processor fee · ${p.provider} · ${p.reference}`, createdBy: SYSTEM_USER,
      lines: [dr(ACC.fees, p.fee, `${p.provider} fee`), cr(cash, p.fee)],
    });
}

/**
 * order.refunded / order.cancelled: reverse revenue in proportion to the order journal.
 * Where the money went: wallet refunds = WalletTransaction(kind refund, meta.orderNumber) → Cr 2000;
 * the rest of `order.amountRefunded` went back through the provider (Refund rows) → Cr 1010
 * (Cr 1000 when the order was only paid by manual bank/POS confirmation).
 * Delta-based: posts only what isn't journaled yet, so repeated / partial refunds are safe.
 */
export async function journalOrderRefund(orderId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
    const o = await tx.order.findUnique({ where: { id: orderId }, include: { payments: { where: { status: { in: ["succeeded", "partially_refunded", "refunded"] } } } } });
    if (!o || o.amountRefunded <= 0) return null;
    // never paid → nothing was booked (wallet spend + refund cancel out)
    const sale = await tx.journalEntry.findFirst({ where: { source: "order", reference: o.number, status: "posted" }, include: { lines: true } });
    if (!sale) return null;

    const walletTx = await tx.walletTransaction.findMany({ where: { kind: "refund", status: "completed", meta: { path: "$.orderNumber", equals: o.number } }, select: { amount: true } });
    const toWallet = Math.min(o.amountRefunded, walletTx.reduce((n, t) => n + t.amount, 0));
    const toCard = o.amountRefunded - toWallet;
    const cardAcc = o.payments.length && o.payments.every((p) => p.provider === "manual") ? ACC.bank : ACC.clearing;

    const done = await tx.journalLine.groupBy({
      by: ["accountCode"],
      where: { entry: { source: "refund", reference: o.number, status: { not: "void" } } },
      _sum: { credit: true, debit: true },
    });
    const booked = (code: string) => Number(done.find((d) => d.accountCode === code)?._sum.credit ?? 0);
    const dWallet = Math.max(0, toWallet - booked(ACC.wallets));
    const dCard = Math.max(0, toCard - booked(ACC.clearing) - booked(ACC.bank));
    const amount = dWallet + dCard;
    if (amount <= 0) return null;

    // reverse each revenue / VAT line of the sale in proportion — cumulatively, so a series of
    // partial refunds that adds up to the whole order reverses every line exactly (no rounding drift)
    const credits = sale.lines.filter((l) => l.credit > 0n).map((l) => ({ code: l.accountCode, credit: Number(l.credit) }));
    const totalCredit = credits.reduce((n, l) => n + l.credit, 0);
    const cumulative = Math.min(totalCredit, booked(ACC.wallets) + booked(ACC.clearing) + booked(ACC.bank) + amount);
    const reversed = (code: string) => Number(done.find((d) => d.accountCode === code)?._sum.debit ?? 0);
    const salesCode = credits.some((l) => l.code === ACC.sales) ? ACC.sales : credits[0].code;
    const debits = credits
      .filter((l) => l.code !== salesCode)
      .map((l) => ({ code: l.code, amount: Math.max(0, Math.round((cumulative * l.credit) / totalCredit) - reversed(l.code)) }));
    debits.unshift({ code: salesCode, amount: amount - debits.reduce((n, d) => n + d.amount, 0) });

    return ledgerService.post(
      {
        source: "refund", reference: o.number, date: new Date(), createdBy: SYSTEM_USER,
        description: `Refund · ${o.number}${o.status === "cancelled" ? " (cancelled)" : ""}`,
        lines: nz([
          ...debits.map((d) => dr(d.code, d.amount, d.code === ACC.vat ? "VAT reversed" : "Revenue reversed")),
          cr(ACC.wallets, dWallet, "Refund to ASL Wallet"),
          cr(cardAcc, dCard, "Refund to original payment"),
        ]),
      },
      tx,
    );
  });
}

/** admin wallet credits / adjustments (goodwill → 5300) and completed withdrawals (→ bank) */
export async function journalWalletTx(txId: string) {
  const t = await prisma.walletTransaction.findUnique({ where: { id: txId } });
  if (!t || t.status !== "completed" || t.amount === 0) return null;
  const amt = Math.abs(t.amount);
  if (t.kind === "credit" || t.kind === "adjustment") {
    const lines = t.amount > 0
      ? [dr(ACC.rewards, amt, t.kind === "credit" ? "Goodwill credit" : "Balance adjustment"), cr(ACC.wallets, amt, "Customer wallet")]
      : [dr(ACC.wallets, amt, "Customer wallet"), cr(ACC.rewards, amt, "Balance adjustment")];
    return ledgerService.postOnce("wallet", t.reference, { date: t.createdAt, description: `Wallet ${t.kind} · ${t.title}`, createdBy: SYSTEM_USER, lines });
  }
  if (t.kind === "withdrawal")
    return ledgerService.postOnce("wallet", t.reference, {
      date: t.createdAt, description: `Wallet withdrawal · ${t.subtitle ?? t.reference}`, createdBy: SYSTEM_USER,
      lines: [dr(ACC.wallets, amt, "Customer wallet"), cr(ACC.bank, amt, "Transfer to customer")],
    });
  return null;
}

/** provider settlement reached the bank: Dr bank / Cr clearing (net; fees and refunds already left clearing) */
export async function journalPayoutPaid(payoutId: string) {
  const p = await prisma.payout.findUnique({ where: { id: payoutId } });
  if (!p || p.net <= 0) return null;
  return ledgerService.postOnce("payout", p.number, {
    date: p.paidAt ?? new Date(), description: `Payout to bank · ${p.provider} · ${p.reference}`, createdBy: SYSTEM_USER,
    lines: [dr(ACC.bank, p.net, `${p.bankName} ${p.bankAccountMasked}`), cr(ACC.clearing, p.net, "Provider settlement")],
  });
}

let registered = false;
export function registerLedgerListeners() {
  if (registered) return;
  registered = true;
  const safe = <T>(name: string, fn: (p: T) => Promise<unknown>) => async (p: T) => {
    try {
      await fn(p);
    } catch (err) {
      // the sale / refund itself already happened: log loudly, finance can book it by hand
      logger.error({ err, payload: p }, `ledger: ${name} journal failed`);
    }
  };
  events.on("order.paid", safe("order.paid", (p) => journalOrderPaid(p.orderId)));
  events.on("payment.succeeded", safe("payment.succeeded", (p) => journalPayment(p.paymentId)));
  events.on("order.refunded", safe("order.refunded", (p) => journalOrderRefund(p.orderId)));
  events.on("order.cancelled", safe("order.cancelled", (p) => journalOrderRefund(p.orderId)));
  events.on("wallet.posted", safe("wallet.posted", (p) => journalWalletTx(p.txId)));
  events.on("payout.paid", safe("payout.paid", (p) => journalPayoutPaid(p.payoutId)));
}
