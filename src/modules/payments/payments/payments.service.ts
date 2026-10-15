/**
 * Every money-in goes through here: orders, wallet top-ups (later: deposits, concierge, drafts).
 * Modules register what happens when a payment for their purpose succeeds or fails,
 * so this file never imports orders / wallets (no circular dependencies).
 */
import crypto from "node:crypto";
import type { Payment, PaymentPurpose, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { logger } from "@/core/utils/logger";
import { formatNaira } from "@/core/utils/money";
import { notifyStaff } from "@/modules/platform/notification-settings/notification-settings.service";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";
import { paymentProvider, type PaymentMethodKind, type VerifyResult, type WebhookEvent } from "@/providers/payment/payment";

type AfterCommit = () => void | Promise<void>;
type Handler = {
  /** runs inside the payment transaction; may return work to run after commit */
  succeeded(tx: Tx, p: Payment, v: VerifyResult): Promise<AfterCommit | void>;
  failed?(tx: Tx, p: Payment): Promise<AfterCommit | void>;
};
const handlers = new Map<PaymentPurpose, Handler>();
/** transfer.* webhooks (wallet withdrawals) — registered by the wallets module */
let transferHandler: ((ev: WebhookEvent) => Promise<unknown>) | null = null;

/** Refund.status values */
export const REFUND_STATUS = {
  pending: "pending", // sent to the gateway, waiting for refund.processed / refund.failed
  processed: "processed",
  failed: "failed", // gateway gave up: still owed to the customer (retry or move to wallet)
  wallet: "wallet", // a failed refund paid to the ASL Wallet instead
} as const;

/** a gateway error never leaks its raw text to customers; staff see it in the message */
function providerError(err: unknown, what: string): never {
  if (err instanceof ApiError) throw err;
  logger.error({ err: (err as Error)?.message, what }, "payment provider error");
  throw new ApiError(502, "PAYMENT_FAILED", `The payment provider couldn't ${what}: ${(err as Error)?.message ?? "unknown error"}. Nothing was changed — try again.`);
}

export const newReference = (prefix = "ASL") => `${prefix}_${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/** Allow http(s) and native app schemes as post-payment return URLs (no origin allowlist). */
export function safeReturnUrl(url?: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const appScheme = ["asloriginals:", "exp:"].includes(u.protocol);
    const http = u.protocol === "http:" || u.protocol === "https:";
    return appScheme || http ? url : null;
  } catch {
    return null;
  }
}

export type CreatePaymentInput = {
  purpose: PaymentPurpose;
  amount: number;
  email: string;
  customerId?: string | null;
  orderId?: string | null;
  targetType?: string;
  targetId?: string;
  method: PaymentMethodKind | "bank_transfer";
  returnUrl?: string | null;
  /** pay with a saved card (no redirect) */
  savedMethodId?: string | null;
  /** keep the card for next time after a successful payment */
  saveCard?: boolean;
};

async function lockPayment(tx: Tx, reference: string) {
  await tx.$queryRaw`SELECT id FROM \`Payment\` WHERE reference = ${reference} FOR UPDATE`;
  return tx.payment.findUnique({ where: { reference } });
}

export const paymentsService = {
  register(purpose: PaymentPurpose, h: Handler) {
    handlers.set(purpose, h);
  },
  onTransfer(fn: (ev: WebhookEvent) => Promise<unknown>) {
    transferHandler = fn;
  },

  /**
   * Step 1 (inside the caller's transaction): record the pending payment.
   * No network calls here, so DB locks are never held while waiting on the gateway.
   */
  async createRecord(db: Tx | typeof prisma, input: CreatePaymentInput) {
    if (input.amount <= 0) throw ApiError.badRequest("VALIDATION_FAILED", "Nothing to pay.");
    if (input.savedMethodId) {
      const saved = await db.savedPaymentMethod.findFirst({ where: { id: input.savedMethodId, customerId: input.customerId ?? "-" } });
      if (!saved) throw ApiError.notFound("Saved card");
    }
    return db.payment.create({
      data: {
        reference: newReference(), provider: paymentProvider.name, purpose: input.purpose, method: input.savedMethodId ? "saved_card" : input.method,
        amount: input.amount, email: input.email, customerId: input.customerId ?? null, orderId: input.orderId ?? null,
        targetType: input.targetType, targetId: input.targetId,
        providerData: { returnUrl: safeReturnUrl(input.returnUrl), saveCard: !!input.saveCard, savedMethodId: input.savedMethodId ?? null },
      },
    });
  },

  /**
   * Step 2 (after commit): open the gateway checkout, or charge the saved card right away.
   * Returns what the app needs: `authorizationUrl` to open in a browser / web view.
   */
  async begin(reference: string) {
    const p = await prisma.payment.findUniqueOrThrow({ where: { reference } });
    const data = (p.providerData ?? {}) as { savedMethodId?: string | null };
    if (data.savedMethodId) {
      const saved = await prisma.savedPaymentMethod.findUniqueOrThrow({ where: { id: data.savedMethodId } });
      await paymentProvider.chargeSaved({ reference, amount: p.amount, email: p.email, method: "saved_card", savedToken: saved.providerToken, metadata: { purpose: p.purpose } })
        .catch((err) => providerError(err, "charge the saved card"));
      const st = await this.settle(reference);
      return { reference, amount: p.amount, status: st.status, authorizationUrl: null, accessCode: null, provider: paymentProvider.name, publicKey: paymentProvider.publicKey ?? null };
    }
    const intent = await paymentProvider
      .createIntent({ reference, amount: p.amount, email: p.email, method: p.method === "bank_transfer" ? "bank_transfer" : "card", metadata: { purpose: p.purpose } })
      .catch((err) => providerError(err, "open the checkout"));
    // publicKey + accessCode let the apps open the gateway's own SDK / inline popup instead of the web page
    return { reference, amount: p.amount, status: p.status, authorizationUrl: intent.authorizationUrl, accessCode: intent.accessCode, provider: paymentProvider.name, publicKey: paymentProvider.publicKey ?? null };
  },

  /** both steps, for callers without their own transaction (wallet top-up, pay again) */
  async start(input: CreatePaymentInput) {
    const p = await this.createRecord(prisma, input);
    return this.begin(p.reference);
  },

  /**
   * Ask the gateway for the result and apply it once. Safe to call many times
   * (redirect return, webhook, polling) — only the first call changes anything.
   */
  async settle(reference: string) {
    const v = await paymentProvider.verify(reference);
    if (v.status === "pending") return this.publicStatus(reference);
    const after: AfterCommit[] = [];
    await prisma.$transaction(async (tx) => {
      const p = await lockPayment(tx, reference);
      if (!p) throw ApiError.notFound("Payment");
      // "abandoned" = we stopped waiting (order expired / customer retried), but the gateway can still capture it
      if (p.status !== "pending" && p.status !== "abandoned") return;
      if (v.status === "success") {
        if (v.amount < p.amount) {
          logger.error({ reference, expected: p.amount, got: v.amount }, "payment amount mismatch");
          await tx.payment.update({ where: { id: p.id }, data: { status: "failed", providerData: { ...(p.providerData as object), error: "amount_mismatch", got: v.amount } } });
          return;
        }
        const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "succeeded", fee: v.fee, paidAt: new Date() } });
        if ((p.providerData as { saveCard?: boolean })?.saveCard && v.authorization && p.customerId) await saveCard(tx, p.customerId, v);
        const h = handlers.get(p.purpose);
        if (!h) logger.error({ purpose: p.purpose }, "no payment handler registered");
        const fn = await h?.succeeded(tx, updated, v);
        if (fn) after.push(fn);
        after.push(() => events.emit("payment.succeeded", { paymentId: p.id }));
      } else {
        const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "failed" } });
        const fn = await handlers.get(p.purpose)?.failed?.(tx, updated);
        if (fn) after.push(fn);
        after.push(() => events.emit("payment.failed", { paymentId: p.id }));
      }
    });
    for (const fn of after) await fn();
    return this.publicStatus(reference);
  },

  async getByReference(reference: string) {
    const p = await prisma.payment.findUnique({ where: { reference } });
    if (!p) throw ApiError.notFound("Payment");
    return p;
  },

  async publicStatus(reference: string, customerId?: string) {
    const p = await prisma.payment.findUnique({ where: { reference }, include: { order: { select: { id: true, number: true, accessToken: true } } } });
    if (!p || (customerId && p.customerId && p.customerId !== customerId)) throw ApiError.notFound("Payment");
    return {
      reference: p.reference, status: p.status, purpose: p.purpose, amount: p.amount, paidAt: p.paidAt,
      order: p.order ? { id: p.order.id, number: p.order.number } : null,
      returnUrl: (p.providerData as { returnUrl?: string | null })?.returnUrl ?? null,
    };
  },

  /** POST /webhooks/payments/:provider — signature check + dedupe, then settle */
  async webhook(provider: string, rawBody: Buffer | undefined, signature: string | undefined, body: unknown) {
    if (provider !== paymentProvider.name) throw ApiError.notFound("Provider");
    if (!rawBody || !paymentProvider.verifyWebhook(rawBody, signature)) throw new ApiError(401, "UNAUTHENTICATED", "Invalid signature");
    const ev = paymentProvider.parseWebhook(body);
    try {
      await prisma.webhookLog.create({ data: { provider, eventId: ev.eventId, type: ev.type, payload: body as object } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { duplicate: true };
      throw e;
    }
    try {
      switch (ev.type) {
        case "charge.success":
        case "charge.failed":
          if (await prisma.payment.findUnique({ where: { reference: ev.reference }, select: { id: true } })) await this.settle(ev.reference);
          else logger.warn({ provider, reference: ev.reference }, "webhook for an unknown payment reference ignored");
          break;
        case "refund.processed":
        case "refund.failed":
          await this.applyRefundResult(ev);
          break;
        case "transfer.success":
        case "transfer.failed":
        case "transfer.reversed":
          if (transferHandler) await transferHandler(ev);
          else logger.error({ type: ev.type }, "no transfer handler registered");
          break;
        default:
          break;
      }
      await prisma.webhookLog.update({ where: { provider_eventId: { provider, eventId: ev.eventId } }, data: { processedAt: new Date() } });
    } catch (e) {
      await prisma.webhookLog.update({ where: { provider_eventId: { provider, eventId: ev.eventId } }, data: { error: String(e) } });
      throw e;
    }
    return { received: true };
  },

  /**
   * Refund (part of) a succeeded payment back to the card/bank.
   * `amountRefunded` (payment + the caller's order/quote) counts the refund as soon as it is requested — that is what
   * we owe the customer. The Refund row tracks delivery: "processed" (mock: at once), or "pending" until the gateway's
   * refund.processed / refund.failed webhook. A failed refund stays counted and is flagged to finance (retryRefund).
   */
  async refund(tx: Tx, paymentId: string, amount: number, reason: string, actor: string) {
    await tx.$queryRaw`SELECT id FROM \`Payment\` WHERE id = ${paymentId} FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const left = p.amount - p.amountRefunded;
    if (amount <= 0 || amount > left) throw ApiError.badRequest("VALIDATION_FAILED", `You can refund up to ₦${(left / 100).toLocaleString("en-NG")} on this payment.`);
    let r: Awaited<ReturnType<typeof paymentProvider.refund>>;
    try {
      r = await paymentProvider.refund(p.reference, amount);
    } catch (err) {
      providerError(err, `refund ${p.reference}`);
    }
    const row = await tx.refund.create({ data: { paymentId, amount, reason, status: r.status, providerRef: r.refundRef, actor } });
    const refunded = p.amountRefunded + amount;
    await tx.payment.update({ where: { id: paymentId }, data: { amountRefunded: refunded, status: refunded >= p.amount ? "refunded" : "partially_refunded" } });
    return row;
  },

  /** refund.processed / refund.failed webhook */
  async applyRefundResult(ev: WebhookEvent) {
    const outcome = ev.type === "refund.processed" ? REFUND_STATUS.processed : REFUND_STATUS.failed;
    const found = await this.findRefund(ev);
    if (!found) {
      logger.warn({ type: ev.type, reference: ev.reference, refundRef: ev.refundRef }, "refund webhook: no matching refund");
      return null;
    }
    const failed = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Refund\` WHERE id = ${found.id} FOR UPDATE`;
      const r = await tx.refund.findUniqueOrThrow({ where: { id: found.id }, include: { payment: true } });
      if (r.status !== REFUND_STATUS.pending) {
        if (r.status !== outcome) logger.warn({ refundId: r.id, status: r.status, outcome }, "refund webhook for a refund that is no longer pending — ignored");
        return null;
      }
      await tx.refund.update({ where: { id: r.id }, data: { status: outcome, ...(ev.refundRef && !r.providerRef ? { providerRef: ev.refundRef } : {}) } });
      if (outcome !== REFUND_STATUS.failed) return null;
      if (r.payment.orderId)
        await tx.orderEvent.create({
          data: {
            orderId: r.payment.orderId, type: "note", title: "Refund failed — finance to retry", internal: true, actor: "System",
            detail: `${formatNaira(r.amount)} to ${r.payment.method} (${r.payment.reference})${ev.reason ? `: ${ev.reason}` : ""}`,
          },
        });
      return r;
    });
    if (failed)
      await notifyStaff("finance_failed", {
        title: `Refund failed · ${failed.payment.reference}`,
        body: `${formatNaira(failed.amount)} to ${failed.payment.email} could not be returned${ev.reason ? ` (${ev.reason})` : ""}. Retry it or move it to the customer's wallet.`,
        link: `/payments?reference=${encodeURIComponent(failed.payment.reference)}`, entity: `refund:${failed.id}`,
      });
    return found.id;
  },

  /** by the gateway's refund id, else the oldest pending refund of that payment (and amount) */
  async findRefund(ev: WebhookEvent) {
    if (ev.refundRef) {
      const r = await prisma.refund.findFirst({ where: { providerRef: ev.refundRef, payment: { provider: paymentProvider.name } } });
      if (r) return r;
    }
    if (!ev.reference) return null;
    const where = { status: REFUND_STATUS.pending, payment: { reference: ev.reference } };
    return (
      (ev.amount ? await prisma.refund.findFirst({ where: { ...where, amount: ev.amount }, orderBy: { createdAt: "asc" } }) : null) ??
      (await prisma.refund.findFirst({ where, orderBy: { createdAt: "asc" } }))
    );
  },

  /**
   * Finance: a refund the gateway failed is still owed. `original` sends it to the gateway again;
   * `wallet` pays it into the customer's ASL Wallet (Dr provider clearing / Cr 2000 wallet balances).
   */
  async retryRefund(refundId: string, to: "original" | "wallet", actor: string) {
    const r0 = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!r0) throw ApiError.notFound("Refund");
    if (r0.status !== REFUND_STATUS.failed) throw ApiError.conflict("INVALID_STATE", "Only failed refunds can be retried.");
    if (to === "original") {
      let r: Awaited<ReturnType<typeof paymentProvider.refund>>;
      try {
        r = await paymentProvider.refund(r0.payment.reference, r0.amount);
      } catch (err) {
        providerError(err, `refund ${r0.payment.reference}`);
      }
      const n = await prisma.refund.updateMany({ where: { id: r0.id, status: REFUND_STATUS.failed }, data: { status: r.status, providerRef: r.refundRef, actor } });
      if (!n.count) logger.error({ refundId }, "refund retried twice at the same time");
    } else {
      if (!r0.payment.customerId) throw ApiError.badRequest("VALIDATION_FAILED", "This payment has no customer account, so there is no wallet to refund to.");
      // wallets.service imports this file → load it lazily
      const { walletsService } = await import("@/modules/payments/wallets/wallets.service");
      const customerId = r0.payment.customerId;
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM \`Refund\` WHERE id = ${r0.id} FOR UPDATE`;
        const r = await tx.refund.findUniqueOrThrow({ where: { id: r0.id } });
        if (r.status !== REFUND_STATUS.failed) throw ApiError.conflict("INVALID_STATE", "Only failed refunds can be retried.");
        await walletsService.refund(tx, customerId, r.amount, `Refund for ${r0.payment.reference}`, { paymentRef: r0.payment.reference, refundId: r.id });
        await tx.refund.update({ where: { id: r.id }, data: { status: REFUND_STATUS.wallet, actor } });
        await ledgerService.postOnce("refund", `RF-${r.id}`, {
          date: new Date(), description: `Failed card refund moved to wallet · ${r0.payment.reference}`, createdBy: SYSTEM_USER,
          lines: [
            { accountCode: r0.payment.provider === "manual" ? "1000" : "1010", debit: r.amount, credit: 0, memo: "Refund not returned by the provider" },
            { accountCode: "2000", debit: 0, credit: r.amount, memo: "Refund to ASL Wallet" },
          ],
        }, tx);
      });
      events.emit("wallet.changed", { customerId });
    }
    return prisma.refund.findUniqueOrThrow({ where: { id: r0.id } });
  },

  // ── admin "Transactions" ──
  async adminList(q: { page: number; pageSize: number; q?: string; status?: string; purpose?: string }) {
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status as Payment["status"] } : {}),
      ...(q.purpose ? { purpose: q.purpose as PaymentPurpose } : {}),
      ...(q.q ? { OR: [{ reference: { contains: q.q } }, { email: { contains: q.q } }, { order: { number: { contains: q.q } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({ where, ...paging(q), orderBy: { createdAt: "desc" }, include: { order: { select: { number: true } }, refunds: true } }),
      prisma.payment.count({ where }),
    ]);
    return withMeta(
      rows.map((p) => ({
        id: p.id, reference: p.reference, provider: p.provider, purpose: p.purpose, method: p.method, status: p.status, amount: p.amount, fee: p.fee,
        net: p.amount - p.fee - p.amountRefunded, amountRefunded: p.amountRefunded, email: p.email, orderNumber: p.order?.number ?? null,
        paidAt: p.paidAt, createdAt: p.createdAt, refunds: p.refunds,
      })),
      pageMeta(q, total),
    );
  },
};

async function saveCard(tx: Tx, customerId: string, v: VerifyResult) {
  const a = v.authorization!;
  const exists = await tx.savedPaymentMethod.findFirst({ where: { customerId, last4: a.last4, brand: a.brand, expMonth: a.expMonth, expYear: a.expYear } });
  if (exists) return;
  const first = (await tx.savedPaymentMethod.count({ where: { customerId } })) === 0;
  await tx.savedPaymentMethod.create({
    data: { customerId, type: "card", brand: a.brand, last4: a.last4, expMonth: a.expMonth, expYear: a.expYear, bankName: a.bank, providerToken: a.token, provider: paymentProvider.name, isDefault: first },
  });
}
