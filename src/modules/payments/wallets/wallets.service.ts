/**
 * ASL Wallet. Every balance change goes through `post()` inside a transaction with a row lock,
 * so the balance can never go negative and every change has a transaction row.
 */
import crypto from "node:crypto";
import type { Prisma, WalletTransaction, WalletTxKind, WalletTxStatus } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { logger } from "@/core/utils/logger";
import { notifyStaff } from "@/modules/platform/notification-settings/notification-settings.service";
import { paymentProvider, type TransferResult, type WebhookEvent } from "@/providers/payment/payment";
import { fullName } from "@/modules/identity/auth/customer.mapper";

export const walletRef = () => `WTX-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

type PostInput = {
  kind: WalletTxKind;
  /** signed kobo: credits > 0, debits < 0 */
  amount: number;
  title: string;
  subtitle?: string;
  channel: string;
  note?: string;
  meta?: Prisma.InputJsonValue;
  status?: WalletTxStatus;
  /** money moves into `held` instead of leaving (pending withdrawals) */
  hold?: boolean;
  allowFrozen?: boolean;
};

async function lockWallet(tx: Tx, customerId: string) {
  await tx.$queryRaw`SELECT id FROM \`Wallet\` WHERE customerId = ${customerId} FOR UPDATE`;
  const w = await tx.wallet.findUnique({ where: { customerId } });
  return w ?? tx.wallet.create({ data: { customerId } });
}

async function lockTx(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`WalletTransaction\` WHERE id = ${id} FOR UPDATE`;
  const t = await tx.walletTransaction.findUnique({ where: { id }, include: { wallet: { select: { customerId: true } } } });
  if (!t) throw ApiError.notFound("Wallet transaction");
  return t;
}

type WithdrawalMeta = {
  bankAccountId: string; bankCode: string; accountNumber: string; accountName?: string;
  /** set once the transfer is sent to the provider */
  transfer?: { status: "sending" | "sent" | "success" | "failed"; by?: string; at: string; code?: string | null };
};

async function post(tx: Tx, customerId: string, i: PostInput) {
  const w = await lockWallet(tx, customerId);
  if (w.frozen && !i.allowFrozen) throw ApiError.conflict("WALLET_FROZEN", "Your wallet is on hold. Please contact support.");
  const balance = w.balance + i.amount;
  if (balance < 0) throw ApiError.badRequest("INSUFFICIENT_WALLET_BALANCE", `Your wallet balance is ${formatNaira(w.balance)}.`, { balance: w.balance });
  await tx.wallet.update({
    where: { id: w.id },
    data: {
      balance,
      ...(i.hold ? { held: { increment: -i.amount } } : {}),
      ...(i.kind === "spend" ? { totalSpent: { increment: BigInt(-i.amount) } } : {}),
    },
  });
  return tx.walletTransaction.create({
    data: {
      reference: walletRef(), walletId: w.id, kind: i.kind, status: i.status ?? "completed", amount: i.amount, balanceAfter: balance,
      title: i.title, subtitle: i.subtitle, channel: i.channel, note: i.note, meta: i.meta,
    },
  });
}

/** /account/wallet row (the UI's WalletTxn) */
const toCustomerTx = (t: WalletTransaction) => ({
  id: t.id,
  reference: t.reference,
  title: t.title,
  sub: t.subtitle ?? "",
  type: t.amount >= 0 ? "Credit" : "Debit",
  amount: Math.abs(t.amount),
  status: t.status === "completed" ? "Completed" : t.status === "pending" ? "Pending" : t.status === "reversed" ? "Reversed" : "Failed",
  kind: t.kind,
  createdAt: t.createdAt,
});

export const walletsService = {
  post,

  /** checkout: pay part or all of an order from the wallet */
  async spend(tx: Tx, customerId: string, amount: number, orderNumber: string) {
    if (amount <= 0) return null;
    return post(tx, customerId, { kind: "spend", amount: -amount, title: `Payment for order ${orderNumber}`, subtitle: "Applied at checkout", channel: "system", meta: { orderNumber } });
  },

  async refund(tx: Tx, customerId: string, amount: number, title: string, meta?: Prisma.InputJsonValue) {
    if (amount <= 0) return null;
    return post(tx, customerId, { kind: "refund", amount, title, subtitle: "Refund to wallet", channel: "system", meta, allowFrozen: true });
  },

  async balanceOf(customerId: string) {
    const w = await prisma.wallet.findUnique({ where: { customerId } });
    return w ? { balance: w.balance, frozen: w.frozen } : { balance: 0, frozen: false };
  },

  // ── customer /account/wallet ──
  async summary(customerId: string) {
    const w = (await prisma.wallet.findUnique({ where: { customerId } })) ?? (await prisma.wallet.create({ data: { customerId } }));
    const recent = await prisma.walletTransaction.findMany({ where: { walletId: w.id }, orderBy: { createdAt: "desc" }, take: 5 });
    const limits = await settingsService.get("wallet");
    return { balance: w.balance, held: w.held, totalSpent: Number(w.totalSpent), frozen: w.frozen, limits, recent: recent.map(toCustomerTx) };
  },

  async transactions(customerId: string, q: { page: number; pageSize: number; type?: "credit" | "debit" }) {
    const w = await prisma.wallet.findUnique({ where: { customerId } });
    if (!w) return withMeta([], pageMeta(q, 0));
    const where: Prisma.WalletTransactionWhereInput = { walletId: w.id, ...(q.type === "credit" ? { amount: { gt: 0 } } : q.type === "debit" ? { amount: { lt: 0 } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.walletTransaction.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.walletTransaction.count({ where }),
    ]);
    return withMeta(rows.map(toCustomerTx), pageMeta(q, total));
  },

  /** /account/wallet/topup → payment intent; balance is credited when the payment succeeds */
  async topup(customerId: string, input: { amount: number; method: "card" | "bank_transfer"; savedMethodId?: string | null; returnUrl?: string | null }) {
    const limits = await settingsService.get("wallet");
    if (input.amount < limits.minTopup) throw ApiError.badRequest("VALIDATION_FAILED", `Minimum top-up is ${formatNaira(limits.minTopup)}.`);
    if (input.amount > limits.maxTopup) throw ApiError.badRequest("VALIDATION_FAILED", `Maximum top-up is ${formatNaira(limits.maxTopup)}.`);
    const w = await this.balanceOf(customerId);
    if (w.frozen) throw ApiError.conflict("WALLET_FROZEN", "Your wallet is on hold. Please contact support.");
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
    return paymentsService.start({ purpose: "wallet_topup", amount: input.amount, email: c.email, customerId, method: input.method, savedMethodId: input.savedMethodId, returnUrl: input.returnUrl });
  },

  /** /account/wallet/withdraw: money is held, then paid out (auto below the threshold, otherwise after admin approval) */
  async withdraw(customerId: string, input: { amount: number; bankAccountId: string }) {
    const limits = await settingsService.get("wallet");
    if (input.amount < limits.minWithdrawal) throw ApiError.badRequest("VALIDATION_FAILED", `Minimum withdrawal is ${formatNaira(limits.minWithdrawal)}.`);
    const bank = await prisma.bankAccount.findFirst({ where: { id: input.bankAccountId, customerId } });
    if (!bank) throw ApiError.notFound("Bank account");
    const tx = await prisma.$transaction((t) =>
      post(t, customerId, {
        kind: "withdrawal", amount: -input.amount, status: "pending", hold: true, title: "Withdrawal to bank", subtitle: `${bank.bankName} ••••${bank.accountNumber.slice(-4)}`,
        channel: "bank_transfer", meta: { bankAccountId: bank.id, bankCode: bank.bankCode, accountNumber: bank.accountNumber, accountName: bank.accountName },
      }),
    );
    events.emit("wallet.changed", { customerId });
    if (input.amount < limits.autoApproveWithdrawalBelow)
      // provider down / refused: stays pending for staff to approve again
      await this.payOut(tx.id, "system").catch((err) => logger.warn({ err: (err as Error)?.message, txId: tx.id }, "automatic withdrawal payout not sent"));
    return toCustomerTx(await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx.id } }));
  },

  /**
   * Send a pending withdrawal to the bank. The money stays held (status pending) until the provider confirms:
   * mock → at once; Paystack → transfer.success (completed) or transfer.failed / transfer.reversed (back to the balance).
   */
  async payOut(txId: string, actor: string) {
    // claim it first, so two approvals (or approval + auto payout) can never send two transfers
    const t = await prisma.$transaction(async (tx) => {
      const row = await lockTx(tx, txId);
      if (row.kind !== "withdrawal" || row.status !== "pending") throw ApiError.conflict("INVALID_STATE", "Only pending withdrawals can be paid out.");
      const m = row.meta as WithdrawalMeta;
      if (m.transfer) throw ApiError.conflict("INVALID_STATE", "This withdrawal was already sent to the bank. Waiting for the provider's confirmation.");
      await tx.walletTransaction.update({ where: { id: row.id }, data: { meta: { ...m, transfer: { status: "sending", by: actor, at: new Date().toISOString() } } } });
      return row;
    });
    const m = t.meta as WithdrawalMeta;
    let r: TransferResult;
    try {
      r = await paymentProvider.transfer({
        amount: -t.amount, bankCode: m.bankCode, accountNumber: m.accountNumber, accountName: m.accountName, reason: "ASL wallet withdrawal", reference: t.reference,
      });
    } catch (err) {
      // not accepted: release the claim so it can be approved again (the provider rejects a reused reference, so a retry can't pay twice)
      await prisma.walletTransaction.update({ where: { id: txId }, data: { meta: m as Prisma.InputJsonValue } });
      logger.error({ err: (err as Error)?.message, txId }, "withdrawal transfer not accepted");
      throw new ApiError(502, "PAYMENT_FAILED", `The bank transfer couldn't be started: ${(err as Error)?.message ?? "provider error"}. The withdrawal is still pending — try again.`);
    }
    if (r.status === "failed") return this.failWithdrawal(txId, actor, "Transfer failed", { fromProvider: true });
    if (r.status === "success") return this.completeWithdrawal(txId, `Paid out by ${actor}`);
    await prisma.walletTransaction.update({
      where: { id: txId },
      data: { note: `Sent to bank by ${actor} — awaiting confirmation`, meta: { ...m, transfer: { status: "sent", by: actor, at: new Date().toISOString(), code: r.transferCode ?? null } } },
    });
    events.emit("wallet.changed", { customerId: t.wallet.customerId });
    return prisma.walletTransaction.findUniqueOrThrow({ where: { id: txId } });
  },

  /** the bank confirmed the transfer: release the hold, book Dr 2000 / Cr bank */
  async completeWithdrawal(txId: string, note: string) {
    const t = await prisma.$transaction(async (tx) => {
      const row = await lockTx(tx, txId);
      if (row.kind !== "withdrawal" || row.status !== "pending") return null;
      const m = row.meta as WithdrawalMeta;
      await tx.walletTransaction.update({ where: { id: txId }, data: { status: "completed", note, meta: { ...m, transfer: { ...(m.transfer ?? {}), status: "success", at: new Date().toISOString() } } } });
      await tx.wallet.update({ where: { id: row.walletId }, data: { held: { decrement: -row.amount } } });
      return row;
    });
    if (t) {
      events.emit("wallet.changed", { customerId: t.wallet.customerId });
      events.emit("wallet.posted", { txId });
    }
    return prisma.walletTransaction.findUniqueOrThrow({ where: { id: txId } });
  },

  /**
   * Failed / rejected withdrawal → money goes back to the balance.
   * Staff can't fail one the bank is still processing (it may yet succeed); the provider's webhook can.
   */
  async failWithdrawal(txId: string, actor: string, reason: string, o: { fromProvider?: boolean } = {}) {
    const t = await prisma.$transaction(async (tx) => {
      const row = await lockTx(tx, txId);
      if (row.kind !== "withdrawal" || row.status !== "pending") throw ApiError.conflict("INVALID_STATE", "Only pending withdrawals can be failed.");
      const m = row.meta as WithdrawalMeta;
      if (m.transfer && !o.fromProvider)
        throw ApiError.conflict("INVALID_STATE", "The bank is still processing this transfer. It is failed automatically if the provider reports a failure.");
      await lockWallet(tx, row.wallet.customerId);
      await tx.walletTransaction.update({
        where: { id: txId },
        data: { status: "failed", note: `${reason} (${actor})`, ...(m.transfer ? { meta: { ...m, transfer: { ...m.transfer, status: "failed", at: new Date().toISOString() } } } : {}) },
      });
      await tx.wallet.update({ where: { id: row.walletId }, data: { balance: { increment: -row.amount }, held: { decrement: -row.amount } } });
      return row;
    });
    events.emit("wallet.changed", { customerId: t.wallet.customerId });
    return prisma.walletTransaction.findUniqueOrThrow({ where: { id: txId } });
  },

  /** transfer.success / transfer.failed / transfer.reversed webhooks */
  async onTransferEvent(ev: WebhookEvent) {
    const t = await prisma.walletTransaction.findFirst({ where: { reference: ev.reference.toUpperCase(), kind: "withdrawal" }, include: { wallet: { select: { customerId: true } } } });
    if (!t) {
      logger.warn({ type: ev.type, reference: ev.reference }, "transfer webhook: no matching withdrawal");
      return null;
    }
    if (ev.type === "transfer.success") {
      if (t.status === "pending") return this.completeWithdrawal(t.id, "Paid out (bank confirmed)");
      return null;
    }
    const why = ev.type === "transfer.reversed" ? "Transfer reversed by the bank" : "Transfer failed";
    if (t.status === "pending") {
      const r = await this.failWithdrawal(t.id, "provider", ev.reason ? `${why}: ${ev.reason}` : why, { fromProvider: true });
      await notifyStaff("finance_failed", {
        title: `Withdrawal failed · ${t.reference}`, body: `${formatNaira(-t.amount)} returned to the customer's wallet. ${why}${ev.reason ? `: ${ev.reason}` : ""}.`,
        link: `/wallets?q=${encodeURIComponent(t.reference)}`, entity: `wallet_tx:${t.id}`,
      });
      return r;
    }
    if (t.status === "completed")
      // already paid out and booked: the money came back to our bank → finance credits the customer by hand
      await notifyStaff("finance_failed", {
        title: `Completed withdrawal reversed · ${t.reference}`,
        body: `${formatNaira(-t.amount)} came back from the bank after the payout was completed. Credit the customer's wallet (Wallet → Adjust) once the money is in.`,
        link: `/wallets?q=${encodeURIComponent(t.reference)}`, entity: `wallet_tx:${t.id}`,
      });
    return null;
  },

  // ── banks (withdraw form) ──
  listBanks: () => paymentProvider.listBanks(),
  async resolveAccount(bankCode: string, accountNumber: string) {
    try {
      return await paymentProvider.resolveAccount(bankCode, accountNumber);
    } catch {
      throw ApiError.badRequest("VALIDATION_FAILED", "We couldn't verify this account number.");
    }
  },
  myBankAccounts: (customerId: string) => prisma.bankAccount.findMany({ where: { customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] }),
  async addBankAccount(customerId: string, b: { bankCode: string; accountNumber: string }) {
    const banks = await paymentProvider.listBanks();
    const bank = banks.find((x) => x.code === b.bankCode);
    if (!bank) throw ApiError.badRequest("VALIDATION_FAILED", "Unknown bank.");
    const { accountName } = await this.resolveAccount(b.bankCode, b.accountNumber);
    const existing = await prisma.bankAccount.findFirst({ where: { customerId, bankCode: b.bankCode, accountNumber: b.accountNumber } });
    if (existing) return existing;
    const first = (await prisma.bankAccount.count({ where: { customerId } })) === 0;
    return prisma.bankAccount.create({ data: { customerId, bankCode: b.bankCode, bankName: bank.name, accountNumber: b.accountNumber, accountName, isDefault: first } });
  },
  async removeBankAccount(customerId: string, id: string) {
    const r = await prisma.bankAccount.deleteMany({ where: { id, customerId } });
    if (!r.count) throw ApiError.notFound("Bank account");
    return { deleted: true };
  },

  // ── admin /wallets ──
  async adminTransactions(q: { page: number; pageSize: number; q?: string; kind?: WalletTxKind; status?: WalletTxStatus; customerId?: string }) {
    const where: Prisma.WalletTransactionWhereInput = {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.customerId ? { wallet: { customerId: q.customerId } } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q } }, { title: { contains: q.q } }, { wallet: { customer: { OR: [{ firstName: { contains: q.q } }, { lastName: { contains: q.q } }, { email: { contains: q.q } }] } } }] } : {}),
    };
    const [rows, total, totals] = await Promise.all([
      prisma.walletTransaction.findMany({ where, ...paging(q), orderBy: { createdAt: "desc" }, include: { wallet: { select: { customerId: true, frozen: true, customer: { select: { firstName: true, lastName: true, email: true } } } } } }),
      prisma.walletTransaction.count({ where }),
      prisma.wallet.aggregate({ _sum: { balance: true, held: true }, _count: { _all: true } }),
    ]);
    return withMeta(
      rows.map((t) => ({
        id: t.id, reference: t.reference, customerId: t.wallet.customerId, customerName: fullName(t.wallet.customer), customerEmail: t.wallet.customer.email,
        frozen: t.wallet.frozen, kind: t.kind, status: t.status, amount: t.amount, balanceAfter: t.balanceAfter, title: t.title, note: t.note, channel: t.channel, at: t.createdAt,
      })),
      { ...pageMeta(q, total), liabilities: totals._sum.balance ?? 0, held: totals._sum.held ?? 0, wallets: totals._count._all },
    );
  },

  /** goodwill credit / manual correction (+/-) */
  async adjust(input: { customerId: string; amount: number; kind: "credit" | "adjustment"; note: string }, actor: string) {
    const t = await prisma.$transaction((tx) =>
      post(tx, input.customerId, {
        kind: input.kind, amount: input.amount, title: input.kind === "credit" ? "Credit from ASL ORIGINALS" : "Balance adjustment", subtitle: input.note,
        channel: "admin", note: `${input.note} — by ${actor}`, allowFrozen: true,
      }),
    );
    events.emit("wallet.changed", { customerId: input.customerId });
    events.emit("wallet.posted", { txId: t.id });
    return t;
  },

  /** undo a completed credit/debit with an opposite transaction */
  async reverse(txId: string, actor: string) {
    const t = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: txId }, include: { wallet: true } });
    if (t.status !== "completed" || t.kind === "withdrawal") throw ApiError.conflict("INVALID_STATE", "Only completed credits and debits can be reversed.");
    const r = await prisma.$transaction(async (tx) => {
      const rev = await post(tx, t.wallet.customerId, { kind: "adjustment", amount: -t.amount, title: `Reversal of ${t.reference}`, channel: "admin", note: `Reversed by ${actor}`, allowFrozen: true });
      await tx.walletTransaction.update({ where: { id: txId }, data: { status: "reversed" } });
      return rev;
    });
    events.emit("wallet.changed", { customerId: t.wallet.customerId });
    events.emit("wallet.posted", { txId: r.id });
    return r;
  },

  async setFrozen(customerId: string, frozen: boolean) {
    const w = (await prisma.wallet.findUnique({ where: { customerId } })) ?? (await prisma.wallet.create({ data: { customerId } }));
    return prisma.wallet.update({ where: { id: w.id }, data: { frozen } });
  },
};

paymentsService.onTransfer((ev) => walletsService.onTransferEvent(ev));

// a successful top-up payment credits the wallet
paymentsService.register("wallet_topup", {
  async succeeded(tx, p) {
    await post(tx, p.customerId!, { kind: "topup", amount: p.amount, title: "Added to wallet", subtitle: "Wallet top up", channel: p.provider, meta: { paymentRef: p.reference }, allowFrozen: true });
    return () => events.emit("wallet.changed", { customerId: p.customerId! });
  },
});
