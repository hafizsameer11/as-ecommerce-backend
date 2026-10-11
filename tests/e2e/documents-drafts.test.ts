import { beforeAll, describe, expect, it } from "vitest";
import type { Response } from "supertest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;

type Pick = { handle: string; productId: string; variantId: string; size: string | null; color: string | null; price: number };

async function pickProduct(min: number, max: number, minFree = 3, skip: string[] = []): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: min, lte: max }, handle: { notIn: skip } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= minFree);
    if (v) return { handle: p.handle, productId: p.id, variantId: v.id, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error(`no product between ${min} and ${max}`);
}

const free = async (variantId: string) => {
  const l = await prisma.stockLevel.findMany({ where: { variantId } });
  return { onHand: l.reduce((n, s) => n + s.onHand, 0), reserved: l.reduce((n, s) => n + s.reserved, 0) };
};

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  expect(r.status).toBe(200);
  await settle();
}

/** keep PDF responses as raw bytes */
const binary = (res: Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};
const getPdf = (path: string, token?: string) => {
  const r = api().get(path).buffer(true).parse(binary as never);
  return token ? r.set(bearer(token)) : r;
};
const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

/** customer places + pays an order for one product */
async function paidOrder(token: string, email: string, p: Pick, extra: Record<string, unknown> = {}) {
  await api().post(`${S}/cart/items`).set(bearer(token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 });
  await api().patch(`${S}/checkout`).set(bearer(token)).send({ contact: { email, phone: "+2348012345678" }, address: lagos, ...extra });
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  await payMock(r.body.data.payment.reference);
  return r.body.data.order as { id: string; number: string; accessToken: string };
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 240_000);

describe("invoices + packing slips (PDF)", () => {
  let c: Awaited<ReturnType<typeof registerCustomer>>;
  let order: { id: string; number: string; accessToken: string };
  let order2: { id: string; number: string; accessToken: string };

  beforeAll(async () => {
    c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    order = await paidOrder(c.token, c.email, p);
    const p2 = await pickProduct(N(20_000), N(140_000), 3, [p.handle]);
    order2 = await paidOrder(c.token, c.email, p2);
  });

  it("customer downloads the invoice of their own order only", async () => {
    const r = await getPdf(`${S}/me/orders/${order.id}/invoice.pdf`, c.token);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["content-disposition"]).toMatch(/inline; filename="INV-ASL-ORD-\d+\.pdf"/);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    // by order number too
    expect((await getPdf(`${S}/me/orders/${order.number}/invoice.pdf`, c.token)).status).toBe(200);

    const other = await registerCustomer();
    const denied = await api().get(`${S}/me/orders/${order.id}/invoice.pdf`).set(bearer(other.token));
    expect(denied.status).toBe(404);
    expect((await api().get(`${S}/me/orders/${order.id}/invoice.pdf`)).status).toBe(401);
  });

  it("guest gets the invoice with the order access token", async () => {
    const r = await getPdf(`${S}/orders/by-token/${order.accessToken}/invoice.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const bad = await api().get(`${S}/orders/by-token/${"x".repeat(32)}/invoice.pdf`);
    expect(bad.status).toBe(404);
  });

  it("admin invoice + packing slip; print-slips makes one page per order", async () => {
    const inv = await getPdf(`${A}/orders/${order.id}/invoice.pdf`, admin);
    expect(inv.status).toBe(200);
    expect(inv.headers["content-type"]).toBe("application/pdf");
    expect(pages(inv.body)).toBe(1);

    const slip = await getPdf(`${A}/orders/${order.number}/packing-slip.pdf`, admin);
    expect(slip.status).toBe(200);
    expect(slip.headers["content-disposition"]).toContain(`packing-slip-${order.number}.pdf`);

    const multi = await api().post(`${A}/orders/print-slips`).set(bearer(admin)).send({ ids: [order.id, order2.number] }).buffer(true).parse(binary as never);
    expect(multi.status).toBe(200);
    expect(multi.headers["content-type"]).toBe("application/pdf");
    expect(multi.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(pages(multi.body)).toBe(2);

    expect((await api().get(`${A}/orders/nope/invoice.pdf`).set(bearer(admin))).status).toBe(404);
    expect((await api().post(`${A}/orders/print-slips`).set(bearer(admin)).send({ ids: [] })).status).toBe(400);
  });

  it("permissions: orders.view reads PDFs, email-invoice needs orders.edit", async () => {
    const analyst = (await createAdmin("analyst")).token;
    expect((await getPdf(`${A}/orders/${order.id}/invoice.pdf`, analyst)).status).toBe(200);
    expect((await api().post(`${A}/orders/${order.id}/email-invoice`).set(bearer(analyst)).send({})).status).toBe(403);
  });

  it("emails the invoice with the PDF attached", async () => {
    const before = mail.outbox!.length;
    const r = await api().post(`${A}/orders/${order.id}/email-invoice`).set(bearer(admin)).send({});
    expect(r.status).toBe(200);
    expect(r.body.data.sentTo).toBe(c.email);
    const sent = mail.outbox!.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(c.email);
    expect(sent[0].subject).toContain(order.number);
    const att = sent[0].attachments![0];
    expect(att.filename).toBe(`INV-${order.number}.pdf`);
    expect(att.contentType).toBe("application/pdf");
    expect(att.content.subarray(0, 4).toString()).toBe("%PDF");
    const audit = await prisma.auditEvent.findFirst({ where: { action: "order.invoice_emailed" } });
    expect(audit?.entityId).toBe(order.id);
  });
});

describe("draft orders", () => {
  it("create (catalogue + custom line) → send → customer pays the link → paid order, stock committed", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(140_000), 4);
    const before = await free(p.variantId);

    const create = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({
      customerId: c.customer.id,
      items: [
        { productId: p.handle, size: p.size, color: p.color, qty: 2 },
        { name: "Custom monogram", brand: "ASL ORIGINALS", qty: 1, unitPrice: N(15_000) },
      ],
      discount: N(5_000),
      shipping: N(4_000),
      note: "VIP price hold",
    });
    expect(create.status).toBe(201);
    const d = create.body.data;
    expect(d.number).toMatch(/^DFT-\d+$/);
    expect(d.status).toBe("draft");
    expect(d.statusLabel).toBe("Draft");
    expect(d.customerName).toBe("John Doe");
    expect(d.email).toBe(c.email);
    expect(d.subtotal).toBe(p.price * 2 + N(15_000));
    expect(d.total).toBe(p.price * 2 + N(15_000) - N(5_000) + N(4_000));
    expect(d.items[0].variantId).toBe(p.variantId);
    expect(d.items[1].custom).toBe(true);
    expect(d.itemsCount).toBe(3);

    // pay link isn't live before sending
    const list = await api().get(`${A}/draft-orders?tab=draft`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.meta.tabs.draft).toBeGreaterThanOrEqual(1);
    expect(list.body.meta.kpis.combinedValue).toBeGreaterThanOrEqual(d.total);

    const outbox = mail.outbox!.length;
    const sent = await api().post(`${A}/draft-orders/${d.id}/send`).set(bearer(admin)).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe("sent");
    expect(sent.body.data.statusLabel).toBe("Sent to customer");
    const payUrl = sent.body.data.payUrl as string;
    expect(payUrl).toMatch(/\/pay\/[\w-]{32}$/);
    const msg = mail.outbox!.slice(outbox).find((m) => m.to === c.email)!;
    expect(msg.subject).toContain(d.number);
    expect(msg.text).toContain(payUrl);
    expect(msg.html).toContain(payUrl);
    const token = payUrl.split("/pay/")[1];

    const view = await api().get(`${S}/pay/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.total).toBe(d.total);
    expect(view.body.data.items).toHaveLength(2);
    expect(view.body.data.note).toBeUndefined();

    const noKey = await api().post(`${S}/pay/${token}`).send({});
    expect(noKey.status).toBe(400);
    const pay = await api().post(`${S}/pay/${token}`).set("Idempotency-Key", uniq("pay")).send({});
    expect(pay.status).toBe(200);
    expect(pay.body.data.amount).toBe(d.total);
    expect(pay.body.data.authorizationUrl).toContain("/mock/checkout/");
    await payMock(pay.body.data.reference);

    const after = await api().get(`${A}/draft-orders/${d.number}`).set(bearer(admin));
    expect(after.body.data.status).toBe("converted");
    expect(after.body.data.orderNumber).toMatch(/^ASL-ORD-\d+$/);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: after.body.data.orderId }, include: { items: true, payments: true } });
    expect(order.channel).toBe("draft");
    expect(order.status).toBe("paid");
    expect(order.paymentStatus).toBe("paid");
    expect(order.customerId).toBe(c.customer.id);
    expect(order.total).toBe(d.total);
    expect(order.amountPaid).toBe(d.total);
    expect(order.items).toHaveLength(2);
    expect(order.items.find((i) => i.name === "Custom monogram")!.variantId).toBeNull();
    expect(order.payments[0].purpose).toBe("draft_order");

    const stock = await free(p.variantId);
    expect(stock.onHand).toBe(before.onHand - 2);
    expect(stock.reserved).toBe(before.reserved);

    // the customer sees it in their orders; the link is dead now
    const mine = await api().get(`${S}/me/orders/${order.number}`).set(bearer(c.token));
    expect(mine.status).toBe(200);
    expect((await api().get(`${S}/pay/${token}`)).status).toBe(404);
    // and can download the invoice
    expect((await getPdf(`${S}/me/orders/${order.id}/invoice.pdf`, c.token)).status).toBe(200);
  });

  it("expired pay link → 404", async () => {
    const r = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({
      customerName: "Guest · WhatsApp", email: `${uniq("g")}@test.dev`, items: [{ name: "Fragrance bundle", qty: 1, unitPrice: N(189_000) }],
    });
    expect(r.status).toBe(201);
    const s = await api().post(`${A}/draft-orders/${r.body.data.id}/send`).set(bearer(admin)).send({});
    const token = (s.body.data.payUrl as string).split("/pay/")[1];
    expect((await api().get(`${S}/pay/${token}`)).status).toBe(200);
    await prisma.draftOrder.update({ where: { id: r.body.data.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect((await api().get(`${S}/pay/${token}`)).status).toBe(404);
    expect((await api().post(`${S}/pay/${token}`).set("Idempotency-Key", uniq("pay")).send({})).status).toBe(404);
    expect((await api().get(`${S}/pay/${"y".repeat(32)}`)).status).toBe(404);
  });

  it("offline convert → paid order; edit / duplicate / delete rules", async () => {
    const p = await pickProduct(N(10_000), N(140_000), 3);
    const before = await free(p.variantId);
    const email = `${uniq("g")}@test.dev`;
    const r = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({
      customerName: "Adaeze O.", email, items: [{ productId: p.productId, size: p.size, color: p.color, qty: 1, unitPrice: p.price - N(1_000) }],
    });
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    expect(r.body.data.total).toBe(p.price - N(1_000));

    // edit while still a draft
    const upd = await api().patch(`${A}/draft-orders/${id}`).set(bearer(admin)).send({ shipping: N(4_000), note: "Price agreed on WhatsApp" });
    expect(upd.status).toBe(200);
    expect(upd.body.data.total).toBe(p.price - N(1_000) + N(4_000));
    const tooMuch = await api().patch(`${A}/draft-orders/${id}`).set(bearer(admin)).send({ discount: N(10_000_000) });
    expect(tooMuch.status).toBe(400);

    const dup = await api().post(`${A}/draft-orders/${id}/duplicate`).set(bearer(admin));
    expect(dup.status).toBe(201);
    expect(dup.body.data.number).not.toBe(r.body.data.number);
    expect(dup.body.data.status).toBe("draft");
    expect(dup.body.data.total).toBe(upd.body.data.total);
    const del = await api().delete(`${A}/draft-orders/${dup.body.data.id}`).set(bearer(admin));
    expect(del.status).toBe(200);
    expect(await prisma.draftOrder.count({ where: { id: dup.body.data.id } })).toBe(0);

    const conv = await api().post(`${A}/draft-orders/${id}/convert`).set(bearer(admin)).send({ reference: "GTB-TRF-88812", method: "bank_transfer" });
    expect(conv.status).toBe(200);
    expect(conv.body.data.status).toBe("converted");
    await settle();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: conv.body.data.orderId }, include: { payments: true, events: true } });
    expect(order.channel).toBe("draft");
    expect(order.status).toBe("paid");
    expect(order.paymentStatus).toBe("paid");
    expect(order.guestEmail).toBe(email);
    expect(order.amountPaid).toBe(order.total);
    expect(order.payments[0].provider).toBe("manual");
    expect(order.events.map((e) => e.type)).toEqual(["placed", "payment_confirmed"]);
    const stock = await free(p.variantId);
    expect(stock.onHand).toBe(before.onHand - 1);
    expect(stock.reserved).toBe(before.reserved);

    // converted drafts are locked
    expect((await api().post(`${A}/draft-orders/${id}/convert`).set(bearer(admin)).send({ reference: "AGAIN-1", method: "cash" })).status).toBe(409);
    expect((await api().patch(`${A}/draft-orders/${id}`).set(bearer(admin)).send({ note: "x" })).status).toBe(409);
    expect((await api().delete(`${A}/draft-orders/${id}`).set(bearer(admin))).status).toBe(409);
    expect((await api().post(`${A}/draft-orders/${id}/send`).set(bearer(admin)).send({})).status).toBe(409);

    const tabs = (await api().get(`${A}/draft-orders?tab=converted`).set(bearer(admin))).body;
    expect(tabs.data.every((x: { status: string }) => x.status === "converted")).toBe(true);
    expect(tabs.meta.tabs.converted).toBe(2);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "draft.converted" } });
    expect(audit?.entityId).toBe(id);
  });

  it("validates input and permissions", async () => {
    const noCustomer = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({ items: [{ name: "X", qty: 1, unitPrice: 100 }] });
    expect(noCustomer.status).toBe(400);
    const noPrice = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({ customerName: "A", items: [{ name: "X", qty: 1 }] });
    expect(noPrice.status).toBe(400);
    const badProduct = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({ customerName: "A", items: [{ productId: "does-not-exist", qty: 1 }] });
    expect(badProduct.status).toBe(404);
    const noEmail = await api().post(`${A}/draft-orders`).set(bearer(admin)).send({ customerName: "A", items: [{ name: "X", qty: 1, unitPrice: 100 }] });
    expect((await api().post(`${A}/draft-orders/${noEmail.body.data.id}/send`).set(bearer(admin)).send({})).status).toBe(400);

    const analyst = (await createAdmin("analyst")).token;
    expect((await api().get(`${A}/draft-orders`).set(bearer(analyst))).status).toBe(200);
    expect((await api().post(`${A}/draft-orders`).set(bearer(analyst)).send({ customerName: "A", items: [{ name: "X", qty: 1, unitPrice: 100 }] })).status).toBe(403);
  });
});
