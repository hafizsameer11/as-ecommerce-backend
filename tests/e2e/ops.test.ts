/**
 * Operations hardening: refund outbox (gateway calls after commit, retries, finance alert), /health, /ready,
 * /metrics (+ METRICS_TOKEN), S3 storage driver against a fake client (no network).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { seedCatalog } from "../../prisma/seed/catalog";
import { MockPaymentProvider, setPaymentProvider } from "@/providers/payment/payment";
import { paymentsService, sendRefundsJob, REFUND_MAX_ATTEMPTS, REFUND_RETRY_DELAYS_MS, REFUND_STATUS } from "@/modules/payments/payments/payments.service";
import { storage } from "@/providers/storage/storage";
import { createS3Client, S3Driver } from "@/providers/storage/s3";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

/** the mock gateway, with refund calls recorded and an on/off failure switch */
class FlakyGateway extends MockPaymentProvider {
  refundCalls: { reference: string; amount: number }[] = [];
  failRefunds = false;
  override async refund(reference: string, amount = 0) {
    this.refundCalls.push({ reference, amount });
    if (this.failRefunds) throw new Error("Gateway timeout");
    return { status: "processed" as const, refundRef: `RF_${reference}_${this.refundCalls.length}` };
  }
}
const gw = new FlakyGateway();

let admin: string;

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
  const reference = placed.body.data.payment.reference as string;
  expect((await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome: "success" })).status).toBe(200);
  await settle();
  const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.order.id } });
  expect(order.status).toBe("paid");
  const payment = await prisma.payment.findUniqueOrThrow({ where: { reference } });
  return { c, order, reference, payment };
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  await createAdmin("finance"); // finance_failed alerts go to the finance role
  setPaymentProvider(gw);
}, 240_000);

afterAll(() => setPaymentProvider(new MockPaymentProvider()));

describe("refund outbox", () => {
  it("inside the transaction only a queued row is written; the gateway is called after commit by the sender", async () => {
    const { payment, reference } = await paidOrder();
    const before = gw.refundCalls.length;
    const row = await prisma.$transaction((tx) => paymentsService.refund(tx, payment.id, N(1_000), "Price adjustment", "test"));
    expect(row.status).toBe(REFUND_STATUS.queued);
    expect(gw.refundCalls.length).toBe(before); // no network call inside the transaction
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).amountRefunded).toBe(N(1_000)); // owed at once

    const out = await paymentsService.sendDueRefunds();
    expect(out.sent).toBeGreaterThanOrEqual(1);
    expect(gw.refundCalls.at(-1)).toEqual({ reference, amount: N(1_000) });
    const sent = await prisma.refund.findUniqueOrThrow({ where: { id: row.id } });
    expect(sent).toMatchObject({ status: "processed", attempts: 1, lastError: null });
    expect(sent.providerRef).toMatch(/^RF_/);
    expect(sent.sentAt).toBeTruthy();
    // sending again is a no-op (claimed rows only)
    expect(await paymentsService.sendRefund(row.id)).toBe("skipped");
  });

  it("a rolled-back transaction never reaches the gateway", async () => {
    const { payment } = await paidOrder();
    const before = gw.refundCalls.length;
    await expect(
      prisma.$transaction(async (tx) => {
        await paymentsService.refund(tx, payment.id, N(2_000), "Will roll back", "test");
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    await paymentsService.sendDueRefunds();
    expect(gw.refundCalls.length).toBe(before);
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(0);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).amountRefunded).toBe(0);
  });

  it("customer cancel: the refund is sent right after commit (no Redis → inline)", async () => {
    const { c, order, reference } = await paidOrder();
    const r = await api().post(`${S}/me/orders/${order.id}/cancel`).set(bearer(c.token)).send({ reason: "Changed my mind" });
    expect(r.status).toBe(200);
    expect(gw.refundCalls.at(-1)).toEqual({ reference, amount: order.total });
    expect(await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } })).toMatchObject({ status: "processed", amount: order.total });
  });

  it("gateway errors: the cancel still succeeds, the refund retries with backoff, then fails and alerts finance", async () => {
    const { order, reference } = await paidOrder();
    gw.failRefunds = true;
    try {
      const r = await api().post(`${A}/orders/${order.id}/cancel`).set(bearer(admin)).send({ reason: "Out of stock", refundTo: "original" });
      expect(r.status).toBe(200);
      const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(o).toMatchObject({ status: "cancelled", amountRefunded: order.total }); // our rows committed; money still owed
      let rf = await prisma.refund.findFirstOrThrow({ where: { payment: { reference } } });
      expect(rf).toMatchObject({ status: REFUND_STATUS.queued, attempts: 1, lastError: "Gateway timeout" });
      expect(rf.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + REFUND_RETRY_DELAYS_MS[0] - 5_000);

      // not due yet → the sweep leaves it alone
      const calls = gw.refundCalls.length;
      await paymentsService.sendDueRefunds();
      expect(gw.refundCalls.length).toBe(calls);

      const alertsBefore = await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } });
      // run the sweep at each retry time until the last attempt
      for (let attempt = 2; attempt <= REFUND_MAX_ATTEMPTS; attempt++) {
        rf = await prisma.refund.findUniqueOrThrow({ where: { id: rf.id } });
        await paymentsService.sendDueRefunds(new Date(rf.nextAttemptAt!.getTime() + 1_000));
        rf = await prisma.refund.findUniqueOrThrow({ where: { id: rf.id } });
        expect(rf.attempts).toBe(attempt);
      }
      expect(rf.status).toBe(REFUND_STATUS.failed);
      expect(gw.refundCalls.filter((x) => x.reference === reference)).toHaveLength(REFUND_MAX_ATTEMPTS);
      await settle();
      expect(await prisma.adminNotification.count({ where: { ruleId: "finance_failed" } })).toBeGreaterThan(alertsBefore);
      expect(await prisma.orderEvent.count({ where: { orderId: order.id, internal: true, title: { contains: "Refund failed" } } })).toBe(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).amountRefunded).toBe(order.total);

      // finance retries to the card once the gateway is back: through the outbox, fresh attempts
      gw.failRefunds = false;
      const again = await api().post(`${A}/transactions/refunds/${rf.id}/retry`).set(bearer(admin)).send({ to: "original" });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ status: "processed", attempts: 1, lastError: null });
    } finally {
      gw.failRefunds = false;
    }
  });

  it("a send that never answered (worker died mid-call) is failed for finance to check", async () => {
    const { payment } = await paidOrder();
    const row = await prisma.$transaction((tx) => paymentsService.refund(tx, payment.id, N(500), "Stale", "test"));
    await prisma.refund.update({ where: { id: row.id }, data: { status: REFUND_STATUS.sending, attempts: 1, sentAt: new Date(Date.now() - 60 * 60_000) } });
    const out = await paymentsService.sendDueRefunds();
    expect(out.stale).toBeGreaterThanOrEqual(1);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: REFUND_STATUS.failed });
  });

  it("late payment for a cancelled order: auto-refund from the payment handler is sent after the webhook commits", async () => {
    const { order, payment } = await paidOrder();
    // a second (duplicate) payment on the same paid order
    const dup = await prisma.payment.create({
      data: { reference: uniq("DUP_"), provider: "mock", purpose: "order", method: "card", amount: N(3_000), email: payment.email, customerId: payment.customerId, orderId: order.id },
    });
    expect((await api().post(`${W}/mock/checkout/${dup.reference}/complete`).type("form").send({ outcome: "success" })).status).toBe(200);
    await settle();
    expect(await prisma.refund.findFirstOrThrow({ where: { paymentId: dup.id } })).toMatchObject({ status: "processed", amount: N(3_000), reason: "Duplicate payment" });
    expect(gw.refundCalls.at(-1)).toEqual({ reference: dup.reference, amount: N(3_000) });
  });
});

describe("health, readiness, metrics", () => {
  it("GET /health is liveness only", async () => {
    const r = await api().get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "ok" });
  });

  it("GET /ready checks the database and storage; 503 when one fails", async () => {
    const r = await api().get("/ready");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(r.body.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(["database", "storage", "privateStorage"]));
    expect(r.body.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);

    const original = storage.healthcheck;
    storage.healthcheck = async () => {
      throw new Error("disk full");
    };
    try {
      const bad = await api().get("/ready");
      expect(bad.status).toBe(503);
      expect(bad.body.checks.find((c: { name: string }) => c.name === "storage")).toMatchObject({ ok: false, error: "disk full" });
    } finally {
      storage.healthcheck = original;
    }
  });

  it("GET /metrics: Prometheus text, route templates, payment/refund/job counters; bearer token when METRICS_TOKEN is set", async () => {
    await api().get(`${S}/products/does-not-exist-${uniq()}`);
    await sendRefundsJob({}); // one inline job run
    await settle();
    const r = await api().get("/metrics");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.text).toContain("asl_http_request_duration_seconds_bucket");
    expect(r.text).toMatch(/route="\/api\/v1\/store\/products\/:\w+"/); // template, not the raw id
    expect(r.text).not.toContain("does-not-exist");
    expect(r.text).toMatch(/asl_payments_total\{purpose="order",outcome="succeeded"\} \d+/);
    expect(r.text).toMatch(/asl_refunds_total\{outcome="processed"\} \d+/);
    expect(r.text).toMatch(/asl_refunds_total\{outcome="retry"\} \d+/);
    expect(r.text).toMatch(/asl_jobs_total\{job="[\w.-]+",outcome="completed"\} \d+/);

    env.METRICS_TOKEN = "metrics-secret-123";
    try {
      expect((await api().get("/metrics")).status).toBe(401);
      expect((await api().get("/metrics").set(bearer("wrong"))).status).toBe(401);
      expect((await api().get("/metrics").set(bearer("metrics-secret-123"))).status).toBe(200);
    } finally {
      env.METRICS_TOKEN = undefined;
    }
  });
});

describe("S3 storage driver (fake client, no network)", () => {
  const fake = () => {
    const sent: unknown[] = [];
    const objects = new Map<string, Buffer>();
    return {
      sent,
      client: {
        async send(cmd: unknown) {
          sent.push(cmd);
          if (cmd instanceof PutObjectCommand) objects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, cmd.input.Body as Buffer);
          if (cmd instanceof GetObjectCommand) {
            const b = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
            if (!b) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
            return { Body: { transformToByteArray: async () => new Uint8Array(b) } };
          }
          return {};
        },
      },
    };
  };

  it("public bucket: put / read / delete / url, cache headers", async () => {
    const f = fake();
    const s = new S3Driver(f.client, { bucket: "asl-public", publicUrl: "https://cdn.asl.test/" });
    const out = await s.put("media/2026/10/abc.webp", Buffer.from("img"), "image/webp");
    expect(out).toEqual({ key: "media/2026/10/abc.webp", url: "https://cdn.asl.test/media/2026/10/abc.webp" });
    const put = f.sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ Bucket: "asl-public", Key: "media/2026/10/abc.webp", ContentType: "image/webp", CacheControl: expect.stringContaining("immutable") });
    expect((await s.read("media/2026/10/abc.webp")).toString()).toBe("img");
    await s.delete("media/2026/10/abc.webp");
    expect((f.sent.at(-1) as DeleteObjectCommand).input).toEqual({ Bucket: "asl-public", Key: "media/2026/10/abc.webp" });
    await s.healthcheck();
    expect(f.sent.at(-1)).toBeInstanceOf(HeadBucketCommand);
  });

  it("private prefix: keys under private/, no public URL, never cached; path tricks refused", async () => {
    const f = fake();
    const s = new S3Driver(f.client, { bucket: "asl-public", prefix: "private" });
    const out = await s.put("reports/r1.csv", Buffer.from("a,b"), "text/csv");
    expect(out.url).toBe("private://reports/r1.csv");
    expect((f.sent[0] as PutObjectCommand).input).toMatchObject({ Key: "private/reports/r1.csv", CacheControl: "private, no-store" });
    expect((await s.read("reports/r1.csv")).toString()).toBe("a,b");
    for (const bad of ["../x", "/abs", "a/../../b", "a\\b", ""]) await expect(s.put(bad, Buffer.from(""), "text/plain")).rejects.toThrow("Invalid storage key");
  });

  it("client config: custom endpoint (R2 / MinIO) uses path-style URLs and static keys", async () => {
    const c = createS3Client({ region: "auto", endpoint: "https://acc.r2.cloudflarestorage.com", accessKeyId: "AK", secretAccessKey: "SK" });
    expect(c.config.forcePathStyle).toBe(true);
    expect(await c.config.region()).toBe("auto");
    const creds = await c.config.credentials();
    expect(creds).toMatchObject({ accessKeyId: "AK", secretAccessKey: "SK" });
    c.destroy();
  });
});
