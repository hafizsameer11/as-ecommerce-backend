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
import { corsOrigins, isProd } from "@/config/env";
import { notifyStaff } from "@/modules/platform/notification-settings/notification-settings.service";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";
import { paymentProvider, type PaymentMethodKind, type VerifyResult, type WebhookEvent } from "@/providers/payment/payment";
import { defineJob, jobsRunInline } from "@/core/queue/queue";
import { paymentOutcomes, refundOutcomes } from "@/core/metrics/metrics";

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
  queued: "queued", // outbox: written in the caller's transaction, sent to the gateway after commit (payments.send-refunds)
  sending: "sending", // claimed by a sender, gateway call in flight
  pending: "pending", // sent to the gateway, waiting for refund.processed / refund.failed
  processed: "processed",
  failed: "failed", // gateway gave up: still owed to the customer (retry or move to wallet)
  wallet: "wallet", // a failed refund paid to the ASL Wallet instead
} as const;

/** refunds the gateway will (or did) take out of the settlement: everything except failed / moved to wallet */
export const REFUND_OWED_STATUSES = [REFUND_STATUS.queued, REFUND_STATUS.sending, REFUND_STATUS.pending, REFUND_STATUS.processed];

/** outbox retries: wait this long after attempt n fails; after the last attempt the refund is failed + flagged to finance */
export const REFUND_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const REFUND_MAX_ATTEMPTS = REFUND_RETRY_DELAYS_MS.length + 1;
/** a "sending" claim older than this means the sender died mid-call: outcome unknown → finance checks the gateway */
const SENDING_STALE_MS = 15 * 60_000;

/** transactions that queued a refund (settle flushes the outbox after commit only when needed) */
const txWithRefunds = new WeakSet<object>();

/** a gateway error never leaks its raw text to customers; staff see it in the message */
function providerError(err: unknown, what: string): never {
  if (err instanceof ApiError) throw err;
  logger.error({ err: (err as Error)?.message, what }, "payment provider error");
  throw new ApiError(502, "PAYMENT_FAILED", `The payment provider couldn't ${what}: ${(err as Error)?.message ?? "unknown error"}. Nothing was changed — try again.`);
}

export const newReference = (prefix = "ASL") => `${prefix}_${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/** only send customers back to our own apps after paying */
export function safeReturnUrl(url?: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const appScheme = ["asloriginals:", ...(isProd ? [] : ["exp:"])].includes(u.protocol);
    const ownSite = corsOrigins.includes(u.origin) || (!isProd && /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
    return appScheme || ownSite ? url : null;
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
    let txUsed: object | null = null;
    await prisma.$transaction(async (tx) => {
      txUsed = tx;
      const p = await lockPayment(tx, reference);
      if (!p) throw ApiError.notFound("Payment");
      // "abandoned" = we stopped waiting (order expired / customer retried), but the gateway can still capture it
      if (p.status !== "pending" && p.status !== "abandoned") return;
      if (v.status === "success") {
        if (v.amount < p.amount) {
          logger.error({ reference, expected: p.amount, got: v.amount }, "payment amount mismatch");
          await tx.payment.update({ where: { id: p.id }, data: { status: "failed", providerData: { ...(p.providerData as object), error: "amount_mismatch", got: v.amount } } });
          after.push(() => void paymentOutcomes.inc({ purpose: p.purpose, outcome: "amount_mismatch" }));
          return;
        }
        const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "succeeded", fee: v.fee, paidAt: new Date() } });
        if ((p.providerData as { saveCard?: boolean })?.saveCard && v.authorization && p.customerId) await saveCard(tx, p.customerId, v);
        const h = handlers.get(p.purpose);
        if (!h) logger.error({ purpose: p.purpose }, "no payment handler registered");
        const fn = await h?.succeeded(tx, updated, v);
        if (fn) after.push(fn);
        after.push(() => {
          paymentOutcomes.inc({ purpose: p.purpose, outcome: "succeeded" });
          events.emit("payment.succeeded", { paymentId: p.id });
        });
      } else {
        const updated = await tx.payment.update({ where: { id: p.id }, data: { status: "failed" } });
        const fn = await handlers.get(p.purpose)?.failed?.(tx, updated);
        if (fn) after.push(fn);
        after.push(() => {
          paymentOutcomes.inc({ purpose: p.purpose, outcome: "failed" });
          events.emit("payment.failed", { paymentId: p.id });
        });
      }
    });
    for (const fn of after) await fn();
    // late / duplicate / no-longer-wanted payments were refunded by the handler: send them now
    if (txUsed && txWithRefunds.has(txUsed)) await this.flushRefunds();
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
   * Refund (part of) a succeeded payment back to the card/bank — inside the caller's transaction.
   * Outbox: no gateway call here. The Refund row is written as "queued" and `amountRefunded` (payment + the caller's
   * order/quote) counts it at once — that is what we owe the customer. After the caller commits, `flushRefunds()`
   * (or the payments.send-refunds sweep, every minute) hands it to the gateway: "processed" (mock: at once), or
   * "pending" until the refund.processed / refund.failed webhook. If the caller's transaction rolls back, nothing
   * was ever sent. Gateway errors are retried with backoff; after the last attempt the refund is failed + flagged
   * to finance (retryRefund).
   */
  async refund(tx: Tx, paymentId: string, amount: number, reason: string, actor: string) {
    await tx.$queryRaw`SELECT id FROM \`Payment\` WHERE id = ${paymentId} FOR UPDATE`;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const left = p.amount - p.amountRefunded;
    if (amount <= 0 || amount > left) throw ApiError.badRequest("VALIDATION_FAILED", `You can refund up to ₦${(left / 100).toLocaleString("en-NG")} on this payment.`);
    const row = await tx.refund.create({ data: { paymentId, amount, reason, status: REFUND_STATUS.queued, actor } });
    const refunded = p.amountRefunded + amount;
    await tx.payment.update({ where: { id: paymentId }, data: { amountRefunded: refunded, status: refunded >= p.amount ? "refunded" : "partially_refunded" } });
    txWithRefunds.add(tx);
    return row;
  },

  /**
   * After commit: send queued refunds to the gateway. Without Redis (tests, quick local runs) they are sent
   * right here, so the caller's response already shows the gateway's answer; with Redis the worker sends them.
   * Never throws — anything left queued is picked up by the every-minute sweep.
   */
  async flushRefunds() {
    try {
      if (jobsRunInline()) await this.sendDueRefunds();
      else await sendRefundsJob({});
    } catch (err) {
      logger.error({ err }, "refund outbox flush failed (the sweep will retry)");
    }
  },

  /** job payments.send-refunds: every due queued refund → gateway; stale "sending" claims → failed for finance */
  async sendDueRefunds(now = new Date(), limit = 50) {
    const stale = await prisma.refund.findMany({ where: { status: REFUND_STATUS.sending, sentAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } }, include: { payment: true }, take: limit });
    for (const r of stale) {
      const reason = "No answer from the gateway — check its dashboard before retrying, it may already be refunded";
      const n = await prisma.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.sending }, data: { status: REFUND_STATUS.failed, lastError: reason } });
      if (n.count) await flagFailedRefund(r, reason);
    }
    const due = await prisma.refund.findMany({
      where: { status: REFUND_STATUS.queued, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: { createdAt: "asc" }, take: limit, select: { id: true },
    });
    const out = { sent: 0, retrying: 0, failed: 0, stale: stale.length };
    for (const { id } of due) {
      const r = await this.sendRefund(id, now);
      if (r === "sent") out.sent++;
      else if (r === "retry") out.retrying++;
      else if (r === "failed") out.failed++;
    }
    return out;
  },

  /** one queued refund → gateway. Claimed atomically, so two senders never send the same refund. */
  async sendRefund(refundId: string, now = new Date()): Promise<"sent" | "retry" | "failed" | "skipped"> {
    const claimed = await prisma.refund.updateMany({
      where: { id: refundId, status: REFUND_STATUS.queued, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      data: { status: REFUND_STATUS.sending, sentAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) return "skipped";
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
    let res: Awaited<ReturnType<typeof paymentProvider.refund>>;
    try {
      res = await paymentProvider.refund(r.payment.reference, r.amount);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 500);
      logger.error({ err: msg, refundId, reference: r.payment.reference, attempt: r.attempts }, "gateway refund failed");
      if (r.attempts >= REFUND_MAX_ATTEMPTS) {
        const n = await prisma.refund.updateMany({ where: { id: r.id, status: REFUND_STATUS.sending }, data: { status: REFUND_STATUS.failed, lastError: msg } });
        if (n.count) await flagFailedRefund(r, msg);
        refundOutcomes.inc({ outcome: "failed" });
        return "failed";
      }
      const wait = REFUND_RETRY_DELAYS_MS[Math.min(r.attempts, REFUND_RETRY_DELAYS_MS.length) - 1];
      await prisma.refund.updateMany({
        where: { id: r.id, status: REFUND_STATUS.sending },
        data: { status: REFUND_STATUS.queued, nextAttemptAt: new Date(now.getTime() + wait), lastError: msg },
      });
      refundOutcomes.inc({ outcome: "retry" });
      return "retry";
    }
    // a refund.processed / refund.failed webhook may have beaten us here (matched by reference): keep its outcome
    const n = await prisma.refund.updateMany({
      where: { id: r.id, status: REFUND_STATUS.sending },
      data: { status: res.status, providerRef: res.refundRef, nextAttemptAt: null, lastError: null },
    });
    if (!n.count) await prisma.refund.updateMany({ where: { id: r.id, providerRef: null }, data: { providerRef: res.refundRef } });
    refundOutcomes.inc({ outcome: res.status });
    return "sent";
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
      // "sending": the webhook beat our own gateway call's answer (sendRefund keeps this outcome)
      if (r.status !== REFUND_STATUS.pending && r.status !== REFUND_STATUS.sending) {
        if (r.status !== outcome) logger.warn({ refundId: r.id, status: r.status, outcome }, "refund webhook for a refund that is no longer pending — ignored");
        return null;
      }
      await tx.refund.update({ where: { id: r.id }, data: { status: outcome, ...(ev.refundRef && !r.providerRef ? { providerRef: ev.refundRef } : {}) } });
      refundOutcomes.inc({ outcome: outcome === REFUND_STATUS.failed ? "webhook_failed" : "webhook_processed" });
      return outcome === REFUND_STATUS.failed ? r : null;
    });
    if (failed) await flagFailedRefund(failed, ev.reason);
    return found.id;
  },

  /** by the gateway's refund id, else the oldest pending refund of that payment (and amount) */
  async findRefund(ev: WebhookEvent) {
    if (ev.refundRef) {
      const r = await prisma.refund.findFirst({ where: { providerRef: ev.refundRef, payment: { provider: paymentProvider.name } } });
      if (r) return r;
    }
    if (!ev.reference) return null;
    const where = { status: { in: [REFUND_STATUS.pending, REFUND_STATUS.sending] }, payment: { reference: ev.reference } };
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
      // back into the outbox with fresh attempts (a new gateway refund → new providerRef)
      const n = await prisma.refund.updateMany({
        where: { id: r0.id, status: REFUND_STATUS.failed },
        data: { status: REFUND_STATUS.queued, attempts: 0, nextAttemptAt: null, lastError: null, providerRef: null, actor },
      });
      if (!n.count) throw ApiError.conflict("INVALID_STATE", "Only failed refunds can be retried.");
      if (jobsRunInline()) await this.sendRefund(r0.id);
      else await this.flushRefunds();
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

/** a refund the gateway won't take: note on the order + finance alert (retry to card or move to wallet) */
async function flagFailedRefund(r: { id: string; amount: number; payment: Payment }, reason?: string | null) {
  if (r.payment.orderId)
    await prisma.orderEvent.create({
      data: {
        orderId: r.payment.orderId, type: "note", title: "Refund failed — finance to retry", internal: true, actor: "System",
        detail: `${formatNaira(r.amount)} to ${r.payment.method} (${r.payment.reference})${reason ? `: ${reason}` : ""}`.slice(0, 500),
      },
    }).catch((err) => logger.error({ err, refundId: r.id }, "refund failure note not saved"));
  await notifyStaff("finance_failed", {
    title: `Refund failed · ${r.payment.reference}`,
    body: `${formatNaira(r.amount)} to ${r.payment.email} could not be returned${reason ? ` (${reason})` : ""}. Retry it or move it to the customer's wallet.`,
    link: `/payments?reference=${encodeURIComponent(r.payment.reference)}`, entity: `refund:${r.id}`,
  });
}

/** payments.send-refunds: after-commit flushes (with Redis) + the every-minute sweep */
export const sendRefundsJob = defineJob("payments.send-refunds", async () => {
  await paymentsService.sendDueRefunds();
});

async function saveCard(tx: Tx, customerId: string, v: VerifyResult) {
  const a = v.authorization!;
  const exists = await tx.savedPaymentMethod.findFirst({ where: { customerId, last4: a.last4, brand: a.brand, expMonth: a.expMonth, expYear: a.expYear } });
  if (exists) return;
  const first = (await tx.savedPaymentMethod.count({ where: { customerId } })) === 0;
  await tx.savedPaymentMethod.create({
    data: { customerId, type: "card", brand: a.brand, last4: a.last4, expMonth: a.expMonth, expYear: a.expYear, bankName: a.bank, providerToken: a.token, provider: paymentProvider.name, isDefault: first },
  });
}
