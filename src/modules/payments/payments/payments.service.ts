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
import { corsOrigins, isProd } from "@/config/env";
import { paymentProvider, type PaymentMethodKind, type VerifyResult } from "@/providers/payment/payment";

type AfterCommit = () => void | Promise<void>;
type Handler = {
  /** runs inside the payment transaction; may return work to run after commit */
  succeeded(tx: Tx, p: Payment, v: VerifyResult): Promise<AfterCommit | void>;
  failed?(tx: Tx, p: Payment): Promise<AfterCommit | void>;
};
const handlers = new Map<PaymentPurpose, Handler>();

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
      await paymentProvider.chargeSaved({ reference, amount: p.amount, email: p.email, method: "saved_card", savedToken: saved.providerToken });
      const st = await this.settle(reference);
      return { reference, amount: p.amount, status: st.status, authorizationUrl: null, accessCode: null };
    }
    const intent = await paymentProvider.createIntent({ reference, amount: p.amount, email: p.email, method: p.method === "bank_transfer" ? "bank_transfer" : "card" });
    return { reference, amount: p.amount, status: p.status, authorizationUrl: intent.authorizationUrl, accessCode: intent.accessCode };
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
      if (ev.type === "charge.success" || ev.type === "charge.failed") await this.settle(ev.reference);
      await prisma.webhookLog.update({ where: { provider_eventId: { provider, eventId: ev.eventId } }, data: { processedAt: new Date() } });
    } catch (e) {
      await prisma.webhookLog.update({ where: { provider_eventId: { provider, eventId: ev.eventId } }, data: { error: String(e) } });
      throw e;
    }
    return { received: true };
  },

  /** refund (part of) a succeeded payment back to the card/bank */
  async refund(tx: Tx, paymentId: string, amount: number, reason: string, actor: string) {
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const left = p.amount - p.amountRefunded;
    if (amount <= 0 || amount > left) throw ApiError.badRequest("VALIDATION_FAILED", `You can refund up to ₦${(left / 100).toLocaleString("en-NG")} on this payment.`);
    const r = await paymentProvider.refund(p.reference, amount);
    await tx.refund.create({ data: { paymentId, amount, reason, status: r.status, providerRef: r.refundRef, actor } });
    const refunded = p.amountRefunded + amount;
    await tx.payment.update({ where: { id: paymentId }, data: { amountRefunded: refunded, status: refunded >= p.amount ? "refunded" : "partially_refunded" } });
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
