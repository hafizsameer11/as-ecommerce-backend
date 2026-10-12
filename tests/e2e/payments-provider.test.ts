/**
 * Paystack adapter (global fetch mocked — the real API is never called), asynchronous refunds / transfers
 * through signed Paystack webhooks, GET /admin/payouts/providers, and concierge refunds after payment (D12).
 */
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { envSchema } from "@/config/env";
import { seedCatalog } from "../../prisma/seed/catalog";
import { createPaymentProvider, MockPaymentProvider, setPaymentProvider } from "@/providers/payment/payment";
import { PaystackProvider } from "@/providers/payment/paystack";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const SK = "sk_test_0123456789abcdef0123456789abcdef";
const PK = "pk_test_0123456789abcdef0123456789abcdef";

// ── a tiny fake Paystack behind the fetch spy ──
type Call = { method: string; path: string; body: any; auth: string | undefined };
const calls: Call[] = [];
const txs = new Map<string, { status: string; amount: number }>();
let refundSeq = 7000;
const ok = (data: unknown) => new Response(JSON.stringify({ status: true, message: "ok", data }), { status: 200, headers: { "content-type": "application/json" } });
const bad = (status: number, message: string) => new Response(JSON.stringify({ status: false, message }), { status, headers: { "content-type": "application/json" } });

function fakePaystack(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.paystack.co") throw new Error(`unexpected fetch ${url.origin}`);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  calls.push({ method, path: url.pathname + url.search, body, auth });
  const p = url.pathname;
  if (method === "POST" && p === "/transaction/initialize") {
    txs.set(body.reference, { status: "ongoing", amount: body.amount });
    return Promise.resolve(ok({ authorization_url: `https://checkout.paystack.com/ac_${body.reference}`, access_code: `ac_${body.reference}`, reference: body.reference }));
  }
  if (method === "GET" && p.startsWith("/transaction/verify/")) {
    const ref = decodeURIComponent(p.split("/").pop()!);
    const t = txs.get(ref);
    if (!t) return Promise.resolve(bad(400, "Transaction reference not found"));
    return Promise.resolve(ok({
      id: 4242, status: t.status, reference: ref, amount: t.amount, fees: t.status === "success" ? 1_500 : null,
      authorization: { authorization_code: "AUTH_secret123", card_type: "visa ", brand: "Visa", last4: "4081", exp_month: "12", exp_year: "2030", bank: "TEST BANK", reusable: true, channel: "card" },
    }));
  }
  if (method === "POST" && p === "/transaction/charge_authorization") {
    txs.set(body.reference, { status: "success", amount: body.amount });
    return Promise.resolve(ok({ status: "success", reference: body.reference, amount: body.amount, fees: 1_000 }));
  }
  if (method === "POST" && p === "/refund") return Promise.resolve(ok({ id: ++refundSeq, status: "pending", amount: body.amount, transaction: { reference: body.transaction } }));
  if (method === "POST" && p === "/transferrecipient") return Promise.resolve(ok({ recipient_code: `RCP_${body.account_number}` }));
  if (method === "POST" && p === "/transfer") return Promise.resolve(ok({ status: "pending", transfer_code: `TRF_${body.reference}`, reference: body.reference }));
  if (method === "GET" && p === "/bank") return Promise.resolve(ok([{ name: "Access Bank", code: "044", active: true }, { name: "GTBank", code: "058", active: true }, { name: "Closed Bank", code: "001", active: false }]));
  if (method === "GET" && p === "/bank/resolve") return Promise.resolve(ok({ account_name: "ADA OBI", account_number: url.searchParams.get("account_number") }));
  return Promise.resolve(bad(404, "Not found"));
}

const sign = (raw: string, key = SK) => crypto.createHmac("sha512", key).update(raw).digest("hex");
/** Paystack → us, signed with the secret key */
async function hook(event: string, data: Record<string, unknown>) {
  const raw = JSON.stringify({ event, data });
  const r = await api().post(`${W}/paystack`).set("x-paystack-signature", sign(raw)).set("Content-Type", "application/json").send(raw);
  await settle();
  return r;
}
/** customer completes the hosted checkout → Paystack sends charge.success */
async function pay(reference: string) {
  txs.get(reference)!.status = "success";
  const r = await hook("charge.success", { id: Math.floor(Math.random() * 1e9), reference, amount: txs.get(reference)!.amount, status: "success" });
  expect(r.status).toBe(200);
}
const lastCall = (path: string) => [...calls].reverse().find((c) => c.path.startsWith(path))!;

let fetchSpy: ReturnType<typeof vi.spyOn>;
const gw = new PaystackProvider({ secretKey: SK, publicKey: PK, callbackUrl: "https://asloriginals.com/payment/return" });

let superAdmin: string;
let agent: string;
let finance: string;

beforeAll(async () => {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fakePaystack as typeof fetch);
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  superAdmin = (await createAdmin("super_admin")).token;
  agent = (await createAdmin("concierge_agent")).token;
  finance = (await createAdmin("finance")).token;
}, 240_000);

afterAll(() => {
  setPaymentProvider(new MockPaymentProvider());
  fetchSpy.mockRestore();
});

describe("PaystackProvider (fetch mocked)", () => {
  it("initialize → authorizationUrl; request shape and secret key header", async () => {
    calls.length = 0;
    const r = await gw.createIntent({ reference: "ASL_T1", amount: N(12_500), email: "ada@test.dev", method: "card", metadata: { purpose: "order" } });
    expect(r).toEqual({ reference: "ASL_T1", authorizationUrl: "https://checkout.paystack.com/ac_ASL_T1", accessCode: "ac_ASL_T1" });
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.path).toBe("/transaction/initialize");
    expect(c.auth).toBe(`Bearer ${SK}`);
    expect(c.body).toMatchObject({ email: "ada@test.dev", amount: N(12_500), currency: "NGN", reference: "ASL_T1", callback_url: "https://asloriginals.com/payment/return", metadata: { purpose: "order" } });
    expect(c.body.channels).toContain("card");
    await gw.createIntent({ reference: "ASL_T2", amount: N(1_000), email: "ada@test.dev", method: "bank_transfer" });
    expect(lastCall("/transaction/initialize").body.channels).toEqual(["bank_transfer"]);
    expect(gw.testMode).toBe(true);
    expect(new PaystackProvider({ secretKey: "sk_live_abc" }).testMode).toBe(false);
  });

  it("verify maps success (fee, reusable card), failed, abandoned and unknown references", async () => {
    txs.set("ASL_V1", { status: "success", amount: N(10_000) });
    const v = await gw.verify("ASL_V1");
    expect(v).toEqual({ status: "success", amount: N(10_000), fee: 1_500, authorization: { token: "AUTH_secret123", brand: "visa", last4: "4081", expMonth: 12, expYear: 2030, bank: "TEST BANK" } });
    txs.set("ASL_V2", { status: "failed", amount: N(10_000) });
    expect(await gw.verify("ASL_V2")).toMatchObject({ status: "failed", fee: 0, authorization: undefined });
    txs.set("ASL_V3", { status: "abandoned", amount: N(10_000) });
    expect((await gw.verify("ASL_V3")).status).toBe("pending");
    expect(await gw.verify("ASL_NOPE")).toEqual({ status: "pending", amount: 0, fee: 0 });
    expect(lastCall("/transaction/verify").method).toBe("GET");
  });

  it("charge_authorization, refund, transfer (recipient + transfer), banks and resolve", async () => {
    const ch = await gw.chargeSaved({ reference: "ASL_C1", amount: N(5_000), email: "ada@test.dev", method: "saved_card", savedToken: "AUTH_x" });
    expect(ch.status).toBe("success");
    expect(lastCall("/transaction/charge_authorization").body).toMatchObject({ authorization_code: "AUTH_x", email: "ada@test.dev", amount: N(5_000), reference: "ASL_C1" });

    const rf = await gw.refund("ASL_V1", N(4_000));
    expect(rf).toEqual({ status: "pending", refundRef: String(refundSeq) });
    expect(lastCall("/refund").body).toEqual({ transaction: "ASL_V1", amount: N(4_000) });

    const tr = await gw.transfer({ amount: N(20_000), bankCode: "058", accountNumber: "0123456789", accountName: "ADA OBI", reason: "ASL wallet withdrawal", reference: "WTX-ABC123DEF" });
    expect(tr).toEqual({ status: "pending", transferCode: "TRF_wtx-abc123def" });
    expect(lastCall("/transferrecipient").body).toEqual({ type: "nuban", name: "ADA OBI", account_number: "0123456789", bank_code: "058", currency: "NGN" });
    expect(lastCall("/transfer").body).toEqual({ source: "balance", amount: N(20_000), recipient: "RCP_0123456789", reason: "ASL wallet withdrawal", currency: "NGN", reference: "wtx-abc123def" });

    expect(await gw.listBanks()).toEqual([{ code: "044", name: "Access Bank" }, { code: "058", name: "GTBank" }]);
    expect(await gw.resolveAccount("058", "0123456789")).toEqual({ accountName: "ADA OBI" });
    expect(lastCall("/bank/resolve").path).toBe("/bank/resolve?account_number=0123456789&bank_code=058");
    await expect(gw.resolveAccount("058", "123")).rejects.toThrow();
  });

  it("errors carry Paystack's message, never the key", async () => {
    fetchSpy.mockImplementationOnce(() => Promise.resolve(bad(400, "Transaction has been fully reversed")));
    const err = (await gw.refund("ASL_X", 100).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("Transaction has been fully reversed");
    expect(JSON.stringify(err)).not.toContain(SK);
  });

  it("webhook signature: HMAC-SHA512 of the raw body with the secret key", () => {
    const raw = JSON.stringify({ event: "charge.success", data: { id: 1, reference: "ASL_1" } });
    expect(gw.verifyWebhook(Buffer.from(raw), sign(raw))).toBe(true);
    expect(gw.verifyWebhook(Buffer.from(raw), sign(raw, "test-webhook-secret"))).toBe(false);
    expect(gw.verifyWebhook(Buffer.from(raw + " "), sign(raw))).toBe(false);
    expect(gw.verifyWebhook(Buffer.from(raw), undefined)).toBe(false);
    expect(gw.verifyWebhook(Buffer.from(raw), "abc")).toBe(false);
  });

  it("parses charge / refund / transfer events", () => {
    expect(gw.parseWebhook({ event: "charge.success", data: { id: 99, reference: "ASL_1", amount: 500 } })).toMatchObject({ eventId: "charge.success:99", type: "charge.success", reference: "ASL_1", amount: 500 });
    expect(gw.parseWebhook({ event: "refund.processed", data: { id: 7001, transaction_reference: "ASL_1", amount: "4000", status: "processed" } }))
      .toMatchObject({ eventId: "refund.processed:7001", type: "refund.processed", reference: "ASL_1", refundRef: "7001", amount: 4000 });
    expect(gw.parseWebhook({ event: "refund.failed", data: { id: 7002, transaction_reference: "ASL_1", amount: 4000 } }).type).toBe("refund.failed");
    for (const t of ["transfer.success", "transfer.failed", "transfer.reversed"])
      expect(gw.parseWebhook({ event: t, data: { id: 5, reference: "wtx-abc", transfer_code: "TRF_1", amount: 100, reason: "Could not credit" } }))
        .toMatchObject({ type: t, reference: "wtx-abc", reason: "Could not credit" });
    expect(gw.parseWebhook({ event: "subscription.create", data: { id: 1 } }).type).toBe("other");
  });

  it("env: secret required for paystack, mock refused in production unless allowed; factory picks the gateway", () => {
    const base = { DATABASE_URL: "mysql://x", JWT_ACCESS_SECRET: "x".repeat(32), JWT_REFRESH_SECRET: "y".repeat(32) };
    const issues = (e: Record<string, string>) => {
      const r = envSchema.safeParse({ ...base, ...e });
      return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    };
    expect(issues({ PAYMENT_PROVIDER: "paystack" })).toContain("PAYSTACK_SECRET_KEY");
    expect(issues({ PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: "nope" })).toContain("PAYSTACK_SECRET_KEY");
    expect(issues({ PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: SK, PAYSTACK_PUBLIC_KEY: PK })).toEqual([]);
    expect(issues({ NODE_ENV: "production" })).toContain("PAYMENT_PROVIDER");
    expect(issues({ NODE_ENV: "production", ALLOW_MOCK_PAYMENTS: "true" })).toEqual([]);
    expect(issues({ NODE_ENV: "production", PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: SK })).toEqual([]);

    expect(createPaymentProvider({ PAYMENT_PROVIDER: "mock" } as never).name).toBe("mock");
    const p = createPaymentProvider({ PAYMENT_PROVIDER: "paystack", PAYSTACK_SECRET_KEY: SK, PAYSTACK_PUBLIC_KEY: PK } as never);
    expect(p).toBeInstanceOf(PaystackProvider);
    expect(p.publicKey).toBe(PK);
  });
});

describe("Paystack as the live gateway", () => {
  beforeAll(() => setPaymentProvider(gw));

  it("top-up: hosted checkout → signed charge.success webhook credits the wallet once", async () => {
    const c = await registerCustomer();
    const top = await api().post(`${S}/me/wallet/topup`).set(bearer(c.token)).set("Idempotency-Key", uniq("t")).send({ amount: N(20_000) });
    expect(top.status).toBe(200);
    expect(top.body.data).toMatchObject({ status: "pending", provider: "paystack", publicKey: PK });
    expect(top.body.data.authorizationUrl).toBe(`https://checkout.paystack.com/ac_${top.body.data.reference}`);
    const ref = top.body.data.reference as string;
    expect(lastCall("/transaction/initialize").body).toMatchObject({ reference: ref, amount: N(20_000), email: c.email, metadata: { purpose: "wallet_topup" } });

    // wrong key → 401; the mock route is not the live provider → 404
    const raw = JSON.stringify({ event: "charge.success", data: { id: 1, reference: ref } });
    expect((await api().post(`${W}/paystack`).set("x-paystack-signature", sign(raw, "test-webhook-secret")).set("Content-Type", "application/json").send(raw)).status).toBe(401);
    expect((await api().post(`${W}/mock`).set("x-signature", sign(raw, "test-webhook-secret")).set("Content-Type", "application/json").send(raw)).status).toBe(404);

    txs.get(ref)!.status = "success";
    const ev = { id: 555001, reference: ref, amount: N(20_000), status: "success" };
    expect((await hook("charge.success", ev)).body.data.received).toBe(true);
    expect((await hook("charge.success", ev)).body.data.duplicate).toBe(true);
    const w = await api().get(`${S}/me/wallet`).set(bearer(c.token));
    expect(w.body.data.balance).toBe(N(20_000));
    const p = await prisma.payment.findUniqueOrThrow({ where: { reference: ref } });
    expect(p).toMatchObject({ provider: "paystack", status: "succeeded", fee: 1_500 });
    // unknown references are acknowledged (so Paystack stops retrying) and ignored
    expect((await hook("charge.success", { id: 555002, reference: "SOMEONE_ELSE" })).status).toBe(200);
  });

  // ── orders: async refunds ──
  const lagos = { fullName: "Ada Obi", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };
  async function paidOrder() {
    const c = await registerCustomer();
    const prod = await prisma.product.findFirstOrThrow({
      where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(90_000) }, variants: { some: { stock: { some: { onHand: { gte: 5 } } } } } },
      include: { variants: { include: { stock: true } } },
    });
    const v = prod.variants.find((x) => x.stock.some((s) => s.onHand - s.reserved >= 2))!;
    expect((await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: prod.handle, size: v.size, color: v.color, qty: 1 })).status).toBe(201);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos });
    const placed = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(placed.status).toBe(201);
    await pay(placed.body.data.payment.reference);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.order.id } });
    expect(order.status).toBe("paid");
    return { c, order, reference: placed.body.data.payment.reference as string };
  }
  const cancel = (token: string, id: string) => api().post(`${S}/me/orders/${id}/cancel`).set(bearer(token)).send({ reason: "Changed my mind" });

  it("cancel → refund stays pending until refund.processed", async () => {
    const { c, order, reference } = await paidOrder();
    const r = await cancel(c.token, order.id);
    expect(r.body.data.statusKey).toBe("cancelled");
    expect(lastCall("/refund").body).toEqual({ transaction: reference, amount: order.total });
    let refund = await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } });
    expect(refund).toMatchObject({ status: "pending", amount: order.total });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).amountRefunded).toBe(order.total);

    const done = await hook("refund.processed", { id: Number(refund.providerRef), transaction_reference: reference, amount: String(order.total), status: "processed" });
    expect(done.status).toBe(200);
    refund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(refund.status).toBe("processed");
    // a late refund.failed for a processed refund changes nothing
    await hook("refund.failed", { id: Number(refund.providerRef), transaction_reference: reference, amount: order.total });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("processed");
  });

  it("refund.failed → failed + flagged to finance; amountRefunded kept; finance moves it to the wallet", async () => {
    const { c, order, reference } = await paidOrder();
    await cancel(c.token, order.id);
    const refund = await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } });
    const alertsBefore = await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } });

    // no refund id in the payload: matched by transaction reference + amount
    expect((await hook("refund.failed", { transaction_reference: reference, amount: order.total, reason: "Card closed" })).status).toBe(200);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("failed");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.amountRefunded).toBe(order.total); // still owed: kept and flagged, not rolled back
    expect(await prisma.orderEvent.count({ where: { orderId: order.id, internal: true, title: { contains: "Refund failed" } } })).toBe(1);
    expect(await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } })).toBeGreaterThan(alertsBefore);
    // failed refunds are not money the provider returned (analytics / settlements)
    const tx = await api().get(`${A}/transactions?q=${reference}`).set(bearer(finance));
    expect(tx.body.data[0].refunds[0].status).toBe("failed");

    expect((await api().post(`${A}/transactions/refunds/${refund.id}/retry`).set(bearer(agent)).send({ to: "wallet" })).status).toBe(403);
    const moved = await api().post(`${A}/transactions/refunds/${refund.id}/retry`).set(bearer(finance)).send({ to: "wallet" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.status).toBe("wallet");
    expect((await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data.balance).toBe(order.total);
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { source: "refund", reference: `RF-${refund.id}` }, include: { lines: true } });
    expect(Number(je.lines.find((l) => l.accountCode === "2000")!.credit)).toBe(order.total);
    expect(Number(je.lines.find((l) => l.accountCode === "1010")!.debit)).toBe(order.total);
    expect((await api().post(`${A}/transactions/refunds/${refund.id}/retry`).set(bearer(finance)).send({ to: "original" })).status).toBe(409);
  });

  it("a failed refund can be sent to the card again", async () => {
    const { c, order, reference } = await paidOrder();
    await cancel(c.token, order.id);
    const refund = await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } });
    await hook("refund.failed", { id: Number(refund.providerRef), transaction_reference: reference, amount: order.total });
    const again = await api().post(`${A}/transactions/refunds/${refund.id}/retry`).set(bearer(finance)).send({});
    expect(again.body.data.status).toBe("pending");
    expect(again.body.data.providerRef).not.toBe(refund.providerRef);
    await hook("refund.processed", { id: Number(again.body.data.providerRef), transaction_reference: reference, amount: order.total });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe("processed");
  });

  // ── wallet withdrawals: async transfers ──
  it("withdrawal: approve sends the transfer, money stays held; transfer.failed returns it; transfer.success completes", async () => {
    const c = await registerCustomer();
    await api().post(`${A}/wallets/adjust`).set(bearer(superAdmin)).send({ customerId: c.customer.id, amount: N(50_000), kind: "credit", note: "Goodwill" });
    const banks = await api().get(`${S}/banks`);
    expect(banks.body.data.map((b: { code: string }) => b.code)).toEqual(["044", "058"]);
    const acct = await api().post(`${S}/me/bank-accounts`).set(bearer(c.token)).send({ bankCode: "058", accountNumber: "0123456789" });
    expect(acct.body.data.accountName).toBe("ADA OBI");
    const wallet = async () => (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data as { balance: number; held: number };

    const wd = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(20_000), bankAccountId: acct.body.data.id });
    const id = wd.body.data.id as string;
    const ap = await api().post(`${A}/wallets/transactions/${id}/approve`).set(bearer(superAdmin));
    expect(ap.status).toBe(200);
    expect(ap.body.data.status).toBe("pending");
    const row = await prisma.walletTransaction.findUniqueOrThrow({ where: { id } });
    expect(lastCall("/transfer").body).toMatchObject({ amount: N(20_000), recipient: "RCP_0123456789", reference: row.reference.toLowerCase() });
    expect(lastCall("/transferrecipient").body.name).toBe("ADA OBI");
    expect(await wallet()).toMatchObject({ balance: N(30_000), held: N(20_000) });
    // in flight: can't be sent twice or failed by hand
    expect((await api().post(`${A}/wallets/transactions/${id}/approve`).set(bearer(superAdmin))).status).toBe(409);
    expect((await api().post(`${A}/wallets/transactions/${id}/mark-failed`).set(bearer(superAdmin)).send({ reason: "Customer asked" })).status).toBe(409);

    const alerts = await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } });
    expect((await hook("transfer.failed", { id: 31, reference: row.reference.toLowerCase(), transfer_code: `TRF_${row.reference}`, amount: N(20_000), reason: "Account dormant" })).status).toBe(200);
    expect(await wallet()).toMatchObject({ balance: N(50_000), held: 0 });
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
    expect(await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } })).toBeGreaterThan(alerts);

    const wd2 = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(10_000), bankAccountId: acct.body.data.id });
    await api().post(`${A}/wallets/transactions/${wd2.body.data.id}/approve`).set(bearer(superAdmin));
    const row2 = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: wd2.body.data.id } });
    expect(await prisma.journalEntry.count({ where: { source: "wallet", reference: row2.reference } })).toBe(0);
    await hook("transfer.success", { id: 32, reference: row2.reference.toLowerCase(), amount: N(10_000) });
    expect(await wallet()).toMatchObject({ balance: N(40_000), held: 0 });
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: row2.id } })).status).toBe("completed");
    expect(await prisma.journalEntry.count({ where: { source: "wallet", reference: row2.reference } })).toBe(1);

    // reversed: same as failed while pending
    const wd3 = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(5_000), bankAccountId: acct.body.data.id });
    await api().post(`${A}/wallets/transactions/${wd3.body.data.id}/approve`).set(bearer(superAdmin));
    const row3 = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: wd3.body.data.id } });
    await hook("transfer.reversed", { id: 33, reference: row3.reference.toLowerCase(), amount: N(5_000) });
    expect(await wallet()).toMatchObject({ balance: N(40_000), held: 0 });
  });

  it("GET /admin/payouts/providers: live gateway + payment method settings", async () => {
    const r = await api().get(`${A}/payouts/providers`).set(bearer(finance));
    expect(r.status).toBe(200);
    expect(r.body.data.active).toMatchObject({ name: "paystack", label: "Paystack", testMode: true, publicKey: PK, asyncRefunds: true });
    expect(r.body.data.active.webhookUrl).toMatch(/\/api\/v1\/webhooks\/payments\/paystack$/);
    expect(JSON.stringify(r.body)).not.toContain(SK);
    const m = r.body.data.methods as { id: string; connected: boolean; gateway: boolean; enabled: boolean }[];
    expect(m.find((x) => x.id === "paystack")).toMatchObject({ gateway: true, connected: true, enabled: true });
    expect(m.find((x) => x.id === "flutterwave")).toMatchObject({ gateway: true, connected: false });
    expect(m.find((x) => x.id === "wallet")).toMatchObject({ gateway: false, connected: true });
    expect((await api().get(`${A}/payouts/providers`).set(bearer(agent))).status).toBe(403);
  });
});

describe("concierge refunds after payment (D12)", () => {
  beforeAll(() => setPaymentProvider(gw));

  const address = { fullName: "Ada Obi", phone: "+2348012345678", address: "12 Admiralty Way", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };
  async function paidRequest(depositPct = 100) {
    const c = await registerCustomer({ name: "Ada Obi" });
    const req = api().post(`${S}/concierge/requests`).set(bearer(c.token));
    for (const [k, v] of Object.entries({ itemName: "Birkin 25", category: "Bags", brand: "Hermès" })) req.field(k, v);
    const created = await req;
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const q = await api().post(`${A}/concierge/requests/${id}/quotes`).set(bearer(agent)).send({ lines: [{ name: "Birkin 25 Gold", qty: 1, price: N(200_000) }], depositPct });
    expect(q.status).toBe(201);
    const acc = await api().post(`${S}/concierge/requests/${id}/quote/accept`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({ address });
    expect(acc.status).toBe(200);
    const reference = acc.body.data.payment.reference as string;
    await pay(reference);
    const quote = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: id } });
    expect(quote.status).toBe("paid");
    return { c, id, number: created.body.data.number as string, quote, reference };
  }
  const refund = (id: string, body: Record<string, unknown>, token = superAdmin) => api().post(`${A}/concierge/requests/${id}/refund`).set(bearer(token)).send(body);
  /** Σ credit − debit on 2200 for one request's journals */
  async function deposits(number: string, reference: string) {
    const lines = await prisma.journalLine.findMany({ where: { accountCode: "2200", entry: { status: "posted", OR: [{ reference }, { reference: { startsWith: number } }] } } });
    return lines.reduce((n, l) => n + Number(l.credit) - Number(l.debit), 0);
  }

  it("customer can't cancel after paying: clear message pointing to support", async () => {
    const { c, id } = await paidRequest();
    const r = await api().post(`${S}/concierge/requests/${id}/cancel`).set(bearer(c.token)).send({ reason: "Found it elsewhere" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already received your payment/);
    expect(r.body.error.message).toMatch(/contact support/);
    expect(r.body.error.details.supportEmail).toBeTruthy();
  });

  it("partial refund to wallet (price reduction), then the rest to the card with cancelRequest", async () => {
    const { c, id, number, quote, reference } = await paidRequest();
    expect(await deposits(number, reference)).toBe(quote.total);
    // money-moving needs orders.refund too (concierge agents only quote)
    expect((await refund(id, { amount: N(10_000), to: "wallet", reason: "Price drop" }, agent)).status).toBe(403);
    expect((await refund(id, { to: "wallet", reason: "Everything" })).status).toBe(400); // full refund needs cancelRequest
    expect((await refund(id, { amount: quote.total + 1, to: "wallet", reason: "Too much" })).status).toBe(400);

    mail.outbox!.length = 0;
    const r1 = await refund(id, { amount: N(10_000), to: "wallet", reason: "Price drop at the boutique" });
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ refunded: N(10_000), to: "wallet", amountPaid: quote.total - N(10_000), cancelled: false });
    expect(r1.body.data.quote).toMatchObject({ status: "paid", total: quote.total - N(10_000), amountPaid: quote.total - N(10_000), balanceDue: 0 });
    expect((await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data.balance).toBe(N(10_000));
    expect(await deposits(number, reference)).toBe(quote.total - N(10_000));
    const je1 = await prisma.journalEntry.findFirstOrThrow({ where: { source: "refund", reference: `${number}-RF1` }, include: { lines: true } });
    expect(Number(je1.lines.find((l) => l.accountCode === "2000")!.credit)).toBe(N(10_000));
    await settle();
    expect(mail.outbox!.some((m) => m.to === c.email && m.subject.includes(number) && (m.text ?? "").includes("ASL Wallet"))).toBe(true);
    let detail = await api().get(`${A}/concierge/requests/${id}`).set(bearer(superAdmin));
    expect(detail.body.data.status).toBe("ordered");
    expect(detail.body.data.timeline.some((t: { text: string }) => t.text.startsWith("Refund of ₦10,000"))).toBe(true);

    const rest = quote.total - N(10_000);
    const r2 = await refund(id, { to: "original", reason: "Item no longer available", cancelRequest: true });
    expect(r2.status).toBe(200);
    expect(r2.body.data).toMatchObject({ refunded: rest, to: "original", amountPaid: 0, cancelled: true });
    expect(lastCall("/refund").body).toEqual({ transaction: reference, amount: rest });
    const rf = await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } });
    expect(rf.status).toBe("pending"); // Paystack confirms later
    const q2 = await prisma.conciergeQuote.findUniqueOrThrow({ where: { id: quote.id } });
    expect(q2).toMatchObject({ amountPaid: 0, status: "declined" });
    detail = await api().get(`${A}/concierge/requests/${id}`).set(bearer(superAdmin));
    expect(detail.body.data.status).toBe("cancelled");
    expect(await deposits(number, reference)).toBe(0);
    const je2 = await prisma.journalEntry.findFirstOrThrow({ where: { source: "refund", reference: `${number}-RF2` }, include: { lines: true } });
    expect(Number(je2.lines.find((l) => l.accountCode === "1010")!.credit)).toBe(rest);
    await settle();
    expect(mail.outbox!.filter((m) => m.to === c.email && m.subject.startsWith("Refund for request")).length).toBe(2);
    expect((await refund(id, { amount: 100, to: "wallet", reason: "Again" })).status).toBe(409); // nothing left

    await hook("refund.processed", { id: Number(rf.providerRef), transaction_reference: reference, amount: rest });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: rf.id } })).status).toBe("processed");
  });

  it("cancel with a partial refund keeps the rest as a cancellation fee (2200 → 4200)", async () => {
    const { id, number, quote, reference } = await paidRequest(30);
    expect(quote.amountPaid).toBe(quote.deposit);
    const back = quote.deposit - N(5_000);
    const r = await refund(id, { amount: back, to: "original", reason: "Customer changed their mind", cancelRequest: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ amountPaid: N(5_000), cancelled: true });
    expect(await deposits(number, reference)).toBe(0);
    const fee = await prisma.journalEntry.findFirstOrThrow({ where: { source: "order", reference: number }, include: { lines: true } });
    expect(Number(fee.lines.find((l) => l.accountCode === "4200")!.credit)).toBe(N(5_000));
  });
});
