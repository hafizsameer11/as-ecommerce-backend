/**
 * Paystack gateway (https://paystack.com/docs/api). Amounts are kobo on both sides.
 *
 *   createIntent  → POST /transaction/initialize           (hosted checkout: authorization_url)
 *   verify        → GET  /transaction/verify/:reference
 *   chargeSaved   → POST /transaction/charge_authorization  (saved card, no redirect)
 *   refund        → POST /refund                            (asynchronous: refund.processed / refund.failed webhooks)
 *   transfer      → POST /transferrecipient + POST /transfer (asynchronous: transfer.success / failed / reversed webhooks)
 *   banks         → GET  /bank, GET /bank/resolve
 *   webhooks      → x-paystack-signature = HMAC-SHA512(raw body, SECRET key)
 *
 * Never logs or returns the secret key, card numbers or authorization codes.
 */
import crypto from "node:crypto";
import { logger } from "@/core/utils/logger";
import type {
  CardAuthorization, CreateIntentInput, IntentResult, PaymentProvider, TransferInput, TransferResult, VerifyResult, WebhookEvent, WebhookEventType,
} from "./payment";

export type PaystackConfig = {
  secretKey: string;
  publicKey?: string;
  callbackUrl?: string;
  baseUrl?: string;
  /** per request (ms) */
  timeoutMs?: number;
};

type PaystackResponse<T> = { status: boolean; message: string; data: T };

/** Paystack error mapped to a safe message (no request body, no key) */
export class PaystackError extends Error {
  constructor(public readonly httpStatus: number, message: string, public readonly path: string) {
    super(message);
    this.name = "PaystackError";
  }
}

const WEBHOOK_TYPES: Record<string, WebhookEventType> = {
  "charge.success": "charge.success",
  "charge.failed": "charge.failed",
  "refund.processed": "refund.processed",
  "refund.failed": "refund.failed",
  "transfer.success": "transfer.success",
  "transfer.failed": "transfer.failed",
  "transfer.reversed": "transfer.reversed",
};

/** checkout channels per method the app picked ("card" also offers bank / USSD on the hosted page) */
const CHANNELS: Record<CreateIntentInput["method"], string[] | undefined> = {
  card: ["card", "bank", "ussd", "bank_transfer"],
  bank_transfer: ["bank_transfer"],
  ussd: ["ussd"],
  saved_card: ["card"],
  paystack: undefined,
};

type PaystackAuthorization = {
  authorization_code?: string; card_type?: string; brand?: string; last4?: string; exp_month?: string | number; exp_year?: string | number;
  bank?: string; reusable?: boolean; channel?: string;
};
type PaystackTransaction = { id?: number; status: string; reference: string; amount: number; fees?: number | null; gateway_response?: string; authorization?: PaystackAuthorization };

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";
  readonly testMode: boolean;
  readonly publicKey: string | undefined;
  private readonly baseUrl: string;
  private banksCache: { at: number; banks: { code: string; name: string }[] } | null = null;

  constructor(private readonly cfg: PaystackConfig) {
    if (!cfg.secretKey) throw new Error("PAYSTACK_SECRET_KEY is required for the Paystack provider");
    this.testMode = cfg.secretKey.startsWith("sk_test_");
    this.publicKey = cfg.publicKey;
    this.baseUrl = (cfg.baseUrl ?? "https://api.paystack.co").replace(/\/$/, "");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.secretKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
      });
    } catch (err) {
      // path only: query strings can hold account numbers
      logger.error({ path: path.split("?")[0], err: (err as Error).message }, "paystack request failed");
      throw new PaystackError(0, "Payment provider unreachable", path.split("?")[0]);
    }
    let json: PaystackResponse<T> | null = null;
    try {
      json = (await res.json()) as PaystackResponse<T>;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || !json?.status) {
      const message = json?.message || `Paystack HTTP ${res.status}`;
      logger.warn({ path: path.split("?")[0], status: res.status, message }, "paystack request rejected");
      throw new PaystackError(res.status, message, path.split("?")[0]);
    }
    return json.data;
  }

  async createIntent(input: CreateIntentInput): Promise<IntentResult> {
    const callback = input.callbackUrl ?? this.cfg.callbackUrl;
    const channels = CHANNELS[input.method];
    const d = await this.call<{ authorization_url: string; access_code: string; reference: string }>("POST", "/transaction/initialize", {
      email: input.email,
      amount: input.amount,
      currency: "NGN",
      reference: input.reference,
      ...(callback ? { callback_url: callback } : {}),
      ...(channels ? { channels } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return { reference: d.reference ?? input.reference, authorizationUrl: d.authorization_url, accessCode: d.access_code };
  }

  async chargeSaved(input: CreateIntentInput & { savedToken: string }): Promise<VerifyResult> {
    const d = await this.call<PaystackTransaction>("POST", "/transaction/charge_authorization", {
      authorization_code: input.savedToken,
      email: input.email,
      amount: input.amount,
      currency: "NGN",
      reference: input.reference,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    return this.toVerify(d);
  }

  async verify(reference: string): Promise<VerifyResult> {
    try {
      return this.toVerify(await this.call<PaystackTransaction>("GET", `/transaction/verify/${encodeURIComponent(reference)}`));
    } catch (err) {
      // not created on Paystack yet (customer never opened the checkout) → still pending for us
      if (err instanceof PaystackError && (err.httpStatus === 400 || err.httpStatus === 404)) return { status: "pending", amount: 0, fee: 0 };
      throw err;
    }
  }

  async refund(reference: string, amount: number) {
    const d = await this.call<{ id: number; status: string; amount?: number }>("POST", "/refund", { transaction: reference, amount });
    // Paystack answers "pending" / "processing" and confirms with refund.processed later
    return { status: d.status === "processed" ? ("processed" as const) : ("pending" as const), refundRef: String(d.id) };
  }

  async transfer(input: TransferInput): Promise<TransferResult> {
    const recipient = await this.call<{ recipient_code: string }>("POST", "/transferrecipient", {
      type: "nuban", name: input.accountName ?? "ASL customer", account_number: input.accountNumber, bank_code: input.bankCode, currency: "NGN",
    });
    const d = await this.call<{ status: string; transfer_code?: string; reference?: string }>("POST", "/transfer", {
      source: "balance",
      amount: input.amount,
      recipient: recipient.recipient_code,
      reason: input.reason,
      currency: "NGN",
      reference: PaystackProvider.transferReference(input.reference),
    });
    const status = d.status === "success" ? "success" : d.status === "failed" || d.status === "abandoned" ? "failed" : "pending";
    return { status, transferCode: d.transfer_code };
  }

  /** Paystack transfer references: lowercase letters, digits, `-` and `_` only */
  static transferReference(ref: string) {
    return ref.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    if (!/^\d{10}$/.test(accountNumber)) throw new Error("Invalid account number");
    const d = await this.call<{ account_name: string; account_number: string }>(
      "GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    return { accountName: d.account_name };
  }

  async listBanks() {
    if (this.banksCache && Date.now() - this.banksCache.at < 6 * 3_600_000) return this.banksCache.banks;
    const d = await this.call<{ name: string; code: string; active?: boolean; is_deleted?: boolean | null }[]>("GET", "/bank?country=nigeria&currency=NGN&perPage=100");
    const banks = d.filter((b) => b.active !== false && !b.is_deleted).map((b) => ({ code: b.code, name: b.name }));
    this.banksCache = { at: Date.now(), banks };
    return banks;
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!signature) return false;
    const expected = crypto.createHmac("sha512", this.cfg.secretKey).update(rawBody).digest("hex");
    return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  parseWebhook(body: any): WebhookEvent {
    const event = String(body?.event ?? "");
    const d = body?.data ?? {};
    const type: WebhookEventType = WEBHOOK_TYPES[event] ?? "other";
    const isRefund = event.startsWith("refund.");
    // Paystack sends no event id: the event name + the object's id (status changes of one object are distinct events)
    const amount = d.amount != null && Number.isFinite(Number(d.amount)) ? Number(d.amount) : undefined;
    const objectId = d.id ?? d.transfer_code ?? d.refund_reference ?? (isRefund ? `${d.transaction_reference}:${amount}` : d.reference);
    return {
      eventId: `${event}:${objectId ?? crypto.createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex").slice(0, 32)}`,
      type,
      reference: String((isRefund ? d.transaction_reference : d.reference) ?? d.reference ?? ""),
      refundRef: isRefund && d.id != null ? String(d.id) : undefined,
      amount,
      reason: d.reason ?? d.gateway_response ?? d.message ?? undefined,
    };
  }

  private toVerify(d: PaystackTransaction): VerifyResult {
    const status = d.status === "success" ? "success" : d.status === "failed" || d.status === "reversed" ? "failed" : "pending";
    const a = d.authorization;
    const authorization: CardAuthorization | undefined =
      status === "success" && a?.reusable && a.authorization_code && a.last4 && (a.channel ?? "card") === "card"
        ? {
            token: a.authorization_code,
            brand: (a.brand ?? a.card_type ?? "card").trim().toLowerCase(),
            last4: a.last4,
            expMonth: Number(a.exp_month) || 0,
            expYear: Number(a.exp_year) || 0,
            bank: a.bank ?? undefined,
          }
        : undefined;
    return { status, amount: d.amount ?? 0, fee: status === "success" ? (d.fees ?? 0) : 0, authorization };
  }
}
