import crypto from "node:crypto";
import { env } from "@/config/env";
import { PaystackProvider } from "./paystack";

export type PaymentMethodKind = "card" | "bank_transfer" | "ussd" | "saved_card" | "paystack";

export type CreateIntentInput = {
  reference: string;
  amount: number; // kobo
  email: string;
  method: PaymentMethodKind;
  savedToken?: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
};

export type IntentResult = {
  reference: string;
  /** open this in a browser / in-app web view to pay */
  authorizationUrl: string;
  accessCode: string;
};

export type VerifyResult = { status: "success" | "failed" | "pending"; amount: number; fee: number; authorization?: CardAuthorization };
export type CardAuthorization = { token: string; brand: string; last4: string; expMonth: number; expYear: number; bank?: string };
export type WebhookEventType =
  | "charge.success" | "charge.failed"
  | "refund.processed" | "refund.failed"
  | "transfer.success" | "transfer.failed" | "transfer.reversed"
  /** anything else the gateway sends (logged, ignored) */
  | "other";
export type WebhookEvent = {
  /** dedupe key (WebhookLog provider + eventId) */
  eventId: string;
  type: WebhookEventType;
  /** charge: payment reference · refund: the refunded payment's reference · transfer: our transfer reference */
  reference: string;
  /** refund events: the gateway's refund id (Refund.providerRef) */
  refundRef?: string;
  amount?: number;
  reason?: string;
};
export type TransferInput = { amount: number; bankCode: string; accountNumber: string; accountName?: string; reason: string; reference: string };
/** "pending" = accepted by the gateway; the final result arrives as a transfer.* webhook */
export type TransferResult = { status: "pending" | "success" | "failed"; transferCode?: string };

/** One interface for every gateway. Paystack / Flutterwave = a new class implementing it. */
export interface PaymentProvider {
  readonly name: string;
  /** test keys / sandbox (shown in admin → payouts → providers) */
  readonly testMode: boolean;
  /** publishable key for in-app SDKs (never the secret) */
  readonly publicKey?: string;
  createIntent(input: CreateIntentInput): Promise<IntentResult>;
  /** charge a saved card without redirect (returns final status) */
  chargeSaved(input: CreateIntentInput & { savedToken: string }): Promise<VerifyResult>;
  verify(reference: string): Promise<VerifyResult>;
  /** "pending" = the gateway confirms later with refund.processed / refund.failed */
  refund(reference: string, amount: number): Promise<{ status: "pending" | "processed"; refundRef: string }>;
  transfer(input: TransferInput): Promise<TransferResult>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
  listBanks(): Promise<{ code: string; name: string }[]>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  parseWebhook(body: any): WebhookEvent;
}

/**
 * Mock gateway that behaves like Paystack: `authorizationUrl` opens a local page with
 * "Pay" / "Fail" buttons, which then fires the webhook. Lets all apps run end-to-end now.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly testMode = true;
  readonly publicKey = undefined;
  /** reference → outcome decided on the mock checkout page */
  private outcomes = new Map<string, { status: "success" | "failed"; amount: number; authorization?: CardAuthorization }>();

  async createIntent(input: CreateIntentInput): Promise<IntentResult> {
    return {
      reference: input.reference,
      accessCode: crypto.randomBytes(8).toString("hex"),
      authorizationUrl: `${env.APP_URL}/api/v1/webhooks/payments/mock/checkout/${encodeURIComponent(input.reference)}`,
    };
  }
  async chargeSaved(input: CreateIntentInput & { savedToken: string }): Promise<VerifyResult> {
    const r: VerifyResult = { status: "success", amount: input.amount, fee: this.fee(input.amount) };
    this.outcomes.set(input.reference, { status: "success", amount: input.amount });
    return r;
  }
  /** called by the mock checkout page / tests */
  settle(reference: string, status: "success" | "failed", amount: number, card = true) {
    this.outcomes.set(reference, {
      status,
      amount,
      authorization: card ? { token: `AUTH_${crypto.randomBytes(6).toString("hex")}`, brand: "visa", last4: "4081", expMonth: 12, expYear: 2030 } : undefined,
    });
  }
  async verify(reference: string): Promise<VerifyResult> {
    const o = this.outcomes.get(reference);
    if (!o) return { status: "pending", amount: 0, fee: 0 };
    return { status: o.status, amount: o.amount, fee: o.status === "success" ? this.fee(o.amount) : 0, authorization: o.authorization };
  }
  async refund(reference: string) {
    return { status: "processed" as const, refundRef: `RF_${reference}` };
  }
  async transfer(): Promise<TransferResult> {
    return { status: "success" };
  }
  async resolveAccount(_bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new Error("Invalid account number");
    return { accountName: "JOHN DOE" };
  }
  async listBanks() {
    return [
      { code: "044", name: "Access Bank" }, { code: "058", name: "GTBank" }, { code: "011", name: "First Bank" },
      { code: "033", name: "UBA" }, { code: "057", name: "Zenith Bank" }, { code: "50211", name: "Kuda Bank" },
      { code: "999992", name: "OPay" }, { code: "50515", name: "Moniepoint" }, { code: "221", name: "Stanbic IBTC" },
    ];
  }
  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    const expected = crypto.createHmac("sha512", env.PAYMENT_WEBHOOK_SECRET).update(rawBody).digest("hex");
    return !!signature && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
  parseWebhook(body: any): WebhookEvent {
    const d = body.data ?? {};
    return {
      eventId: String(body.id), type: body.event, reference: String(d.reference ?? d.transaction_reference),
      refundRef: d.refund_reference ?? undefined, amount: d.amount, reason: d.reason,
    };
  }
  /** Paystack-like fee: 1.5% + ₦100 (above ₦2,500), capped at ₦2,000 */
  private fee(amount: number) {
    const f = Math.round(amount * 0.015) + (amount >= 250_000 ? 10_000 : 0);
    return Math.min(f, 200_000);
  }
}

/** picks the gateway from env at startup (env.ts already refused a missing key / mock in production) */
export function createPaymentProvider(e: Pick<typeof env, "PAYMENT_PROVIDER" | "PAYSTACK_SECRET_KEY" | "PAYSTACK_PUBLIC_KEY" | "PAYSTACK_CALLBACK_URL">): PaymentProvider {
  if (e.PAYMENT_PROVIDER === "paystack")
    return new PaystackProvider({ secretKey: e.PAYSTACK_SECRET_KEY!, publicKey: e.PAYSTACK_PUBLIC_KEY, callbackUrl: e.PAYSTACK_CALLBACK_URL });
  return new MockPaymentProvider();
}

// live binding (ESM) so tests can swap the gateway with setPaymentProvider()
export let paymentProvider: PaymentProvider = createPaymentProvider(env);

/** tests only: run a file against another gateway (e.g. Paystack with a mocked fetch) */
export function setPaymentProvider(p: PaymentProvider) {
  paymentProvider = p;
}
