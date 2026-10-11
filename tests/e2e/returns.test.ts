import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const DAY = 86_400_000;

let admin: string;
let support: string;
let png: Buffer;

type Pick = { handle: string; variantId: string; size: string | null; color: string | null; price: number };
type Customer = Awaited<ReturnType<typeof registerCustomer>>;

async function pickProduct(category: string, skip: string[] = [], minFree = 3): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: {
      status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null,
      price: { gte: N(10_000), lte: N(140_000) }, category: { handle: category }, handle: { notIn: skip },
    },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= minFree);
    if (v) return { handle: p.handle, variantId: v.id, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error(`no ${category} product in stock`);
}

const onHand = async (variantId: string) => (await prisma.stockLevel.findMany({ where: { variantId } })).reduce((n, s) => n + s.onHand, 0);

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

/** buy → pay with the mock gateway → mark delivered `daysAgo` days ago */
async function deliveredOrder(c: Customer, lines: { p: Pick; qty: number }[], o: { daysAgo?: number; coupon?: string; deliver?: boolean } = {}) {
  for (const l of lines) {
    const r = await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: l.p.handle, size: l.p.size, color: l.p.color, qty: l.qty });
    expect(r.status).toBe(201);
  }
  await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos, paymentMethod: "card" });
  if (o.coupon) expect((await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: o.coupon })).status).toBe(200);
  const placed = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(placed.status).toBe(201);
  const pay = await api().post(`${W}/mock/checkout/${placed.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(pay.status).toBe(200);
  await settle();
  const id = placed.body.data.order.id as string;
  if (o.deliver !== false)
    await prisma.order.update({ where: { id }, data: { status: "delivered", deliveredAt: new Date(Date.now() - (o.daysAgo ?? 1) * DAY) } });
  return prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
}

const itemOf = (order: { items: { id: string; variantId: string | null }[] }, p: Pick) => order.items.find((i) => i.variantId === p.variantId)!;

function requestReturn(c: Customer, f: { orderId: string; items: { orderItemId: string; qty: number }[]; reason: string; refundTo?: string; details?: string; photos?: number }, key = uniq("ret")) {
  let r = api().post(`${S}/me/returns`).set(bearer(c.token)).set("Idempotency-Key", key)
    .field("orderId", f.orderId).field("items", JSON.stringify(f.items)).field("reason", f.reason).field("refundTo", f.refundTo ?? "original");
  if (f.details) r = r.field("details", f.details);
  for (let i = 0; i < (f.photos ?? 0); i++) r = r.attach("photos", png, { filename: `damage-${i}.png`, contentType: "image/png" });
  return r;
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  support = (await createAdmin("support")).token;
  png = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
}, 240_000);

describe("returnable items", () => {
  it("lists what can still be returned, and nothing before delivery", async () => {
    const c = await registerCustomer();
    const p = await pickProduct("clothing");
    const notYet = await deliveredOrder(c, [{ p, qty: 2 }], { deliver: false });
    const r0 = await api().get(`${S}/me/orders/${notYet.number}/returnable`).set(bearer(c.token));
    expect(r0.status).toBe(200);
    expect(r0.body.data.eligible).toBe(false);
    expect(r0.body.data.reason).toBe("NOT_DELIVERED");
    expect(r0.body.data.items[0].reason).toBe("NOT_DELIVERED");

    await prisma.order.update({ where: { id: notYet.id }, data: { status: "delivered", deliveredAt: new Date(Date.now() - DAY) } });
    const r = await api().get(`${S}/me/orders/${notYet.id}/returnable`).set(bearer(c.token));
    expect(r.body.data.eligible).toBe(true);
    expect(r.body.data.windowDays).toBe(7);
    expect(r.body.data.reasons).toContain("Damaged or defective");
    expect(r.body.data.items[0]).toMatchObject({ bought: 2, returned: 0, requested: 0, returnable: 2, reason: null });
  });

  it("window closed after windowDays → RETURN_WINDOW_CLOSED", async () => {
    const c = await registerCustomer();
    const p = await pickProduct("clothing");
    const o = await deliveredOrder(c, [{ p, qty: 1 }], { daysAgo: 10 });
    const r = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    expect(r.body.data.eligible).toBe(false);
    expect(r.body.data.items[0].reason).toBe("RETURN_WINDOW_CLOSED");
    const create = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: o.items[0].id, qty: 1 }], reason: "Changed my mind" });
    expect(create.status).toBe(400);
    expect(create.body.error.code).toBe("RETURN_WINDOW_CLOSED");
  });

  it("fragrances are non-returnable", async () => {
    const c = await registerCustomer();
    const frag = await pickProduct("fragrances");
    const shirt = await pickProduct("clothing");
    const o = await deliveredOrder(c, [{ p: frag, qty: 1 }, { p: shirt, qty: 1 }]);
    const r = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    const f = r.body.data.items.find((i: any) => i.orderItemId === itemOf(o, frag).id);
    const s = r.body.data.items.find((i: any) => i.orderItemId === itemOf(o, shirt).id);
    expect(f).toMatchObject({ returnable: 0, reason: "NON_RETURNABLE_CATEGORY" });
    expect(s).toMatchObject({ returnable: 1, reason: null });
    const create = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: itemOf(o, frag).id, qty: 1 }], reason: "Changed my mind" });
    expect(create.status).toBe(400);
    expect(create.body.error.details[0].reason).toBe("NON_RETURNABLE_CATEGORY");
  });
});

describe("customer return requests", () => {
  it("creates a damaged-item return with photos, validates quantity, hides it from other customers", async () => {
    const c = await registerCustomer();
    const p = await pickProduct("clothing");
    const o = await deliveredOrder(c, [{ p, qty: 2 }]);
    const line = o.items[0];

    const noKey = await api().post(`${S}/me/returns`).set(bearer(c.token)).field("orderId", o.id).field("items", JSON.stringify([{ orderItemId: line.id, qty: 1 }])).field("reason", "Wrong size");
    expect(noKey.status).toBe(400);
    const noPhoto = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: line.id, qty: 1 }], reason: "Damaged or defective" });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.error.message).toMatch(/photo/i);
    const tooMany = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: line.id, qty: 3 }], reason: "Wrong size" });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.details[0]).toMatchObject({ returnable: 2 });
    const badReason = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: line.id, qty: 1 }], reason: "Bored" });
    expect(badReason.status).toBe(400);

    const ok = await requestReturn(c, { orderId: o.number, items: [{ orderItemId: line.id, qty: 1 }], reason: "Damaged or defective", details: "Seam split on arrival", photos: 2, refundTo: "wallet" });
    expect(ok.status).toBe(201);
    const ret = ok.body.data;
    expect(ret.number).toMatch(/^RET-\d+$/);
    expect(ret.status).toBe("In Progress");
    expect(ret.statusKey).toBe("requested");
    expect(ret.photos).toHaveLength(2);
    expect(ret.canCancel).toBe(true);
    expect(ret.refundAmount).toBe(line.unitPrice);
    expect(ret.refund.to).toBe("wallet");
    expect(ret.timeline).toHaveLength(1);
    expect(await prisma.mediaAsset.count({ where: { folder: "returns" } })).toBeGreaterThanOrEqual(2);

    // only one more unit left to return
    const after = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    expect(after.body.data.items[0]).toMatchObject({ bought: 2, requested: 1, returnable: 1 });
    const over = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: line.id, qty: 2 }], reason: "Wrong size" });
    expect(over.status).toBe(400);

    const list = await api().get(`${S}/me/returns`).set(bearer(c.token));
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: ret.id, orderNumber: o.number, name: line.name, reason: "Damaged or defective", status: "In Progress" });
    expect(list.body.data[0].statusNote).toBeTruthy();
    expect(list.body.data[0].requestedOn).toBeTruthy();
    expect(list.body.meta.tabs["In Progress"]).toBe(1);

    await settle();
    expect(mail.outbox!.some((m) => m.to === c.email && m.subject.includes(ret.number))).toBe(true);

    const other = await registerCustomer();
    expect((await api().get(`${S}/me/returns/${ret.id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().post(`${S}/me/returns/${ret.id}/cancel`).set(bearer(other.token))).status).toBe(404);
    expect((await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(other.token))).status).toBe(404);
    const steal = await requestReturn(other, { orderId: o.id, items: [{ orderItemId: line.id, qty: 1 }], reason: "Wrong size" });
    expect(steal.status).toBe(404);

    // customer cancels while still awaiting review
    const cancel = await api().post(`${S}/me/returns/${ret.number}/cancel`).set(bearer(c.token));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.cancelled).toBe(true);
    expect(cancel.body.data.statusKey).toBe("rejected");
    expect((await api().post(`${S}/me/returns/${ret.id}/cancel`).set(bearer(c.token))).status).toBe(409);
    const again = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    expect(again.body.data.items[0].returnable).toBe(2);
  });
});

describe("admin RMA flow", () => {
  it("approve → in transit → received (restock) → refund to wallet → order returned", async () => {
    const c = await registerCustomer();
    const p = await pickProduct("clothing");
    const o = await deliveredOrder(c, [{ p, qty: 1 }], { coupon: "asl20off" });
    expect(o.discount).toBeGreaterThan(0);
    const line = o.items[0];
    const created = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: line.id, qty: 1 }], reason: "Wrong size", refundTo: "wallet" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const expected = Math.round(line.unitPrice * (1 - o.discount / o.subtotal));

    const list = await api().get(`${A}/returns?tab=awaiting_review`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.find((r: any) => r.id === id)).toMatchObject({ status: "Awaiting review", order: o.number, items: 1 });
    expect(list.body.meta.tabs.awaiting_review).toBeGreaterThanOrEqual(1);
    expect(list.body.meta.kpis.open).toBeGreaterThanOrEqual(1);

    const detail = await api().get(`${A}/returns/${created.body.data.number}`).set(bearer(admin));
    expect(detail.body.data.suggestedRefund).toBe(expected);
    expect(detail.body.data.actions).toContain("approve");

    // can't refund before approval
    expect((await api().post(`${A}/returns/${id}/refund`).set(bearer(admin)).send({ to: "wallet" })).status).toBe(409);

    const ap = await api().post(`${A}/returns/${id}/approve`).set(bearer(admin)).send({ note: "Send it back with the tags" });
    expect(ap.status).toBe(200);
    expect(ap.body.data.status).toBe("Approved");
    expect((await api().post(`${A}/returns/${id}/approve`).set(bearer(admin)).send({})).status).toBe(409);
    const tr = await api().post(`${A}/returns/${id}/in-transit`).set(bearer(admin)).send({});
    expect(tr.body.data.status).toBe("In transit back");

    const before = await onHand(p.variantId);
    const rc = await api().post(`${A}/returns/${id}/received`).set(bearer(admin)).send({ restock: true, note: "Tags intact" });
    expect(rc.status).toBe(200);
    expect(rc.body.data.status).toBe("Received");
    expect(rc.body.data.restocked).toBe(true);
    expect(await onHand(p.variantId)).toBe(before + 1);
    expect(await prisma.stockMovement.count({ where: { refType: "return", refId: id } })).toBe(1);

    const walletBefore = (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data.balance as number;
    const rf = await api().post(`${A}/returns/${id}/refund`).set(bearer(admin)).send({ to: "wallet" });
    expect(rf.status).toBe(200);
    expect(rf.body.data.status).toBe("Refunded");
    expect(rf.body.data.refund).toBe(expected);
    expect(rf.body.data.refundedAt).toBeTruthy();
    const walletAfter = (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data.balance as number;
    expect(walletAfter - walletBefore).toBe(expected);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } });
    expect(order.status).toBe("returned");
    expect(order.amountRefunded).toBe(expected);
    expect(order.items[0].qtyReturned).toBe(1);
    // refunded twice → no
    expect((await api().post(`${A}/returns/${id}/refund`).set(bearer(admin)).send({ to: "wallet" })).status).toBe(409);

    const mine = await api().get(`${S}/me/returns/${id}`).set(bearer(c.token));
    expect(mine.body.data.status).toBe("Completed");
    expect(mine.body.data.statusNote).toMatch(/wallet/i);
    expect(mine.body.data.timeline.map((e: any) => e.statusKey)).toEqual(["requested", "approved", "in_transit_back", "received", "refunded"]);
    const nothingLeft = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    expect(nothingLeft.body.data.eligible).toBe(false);

    const refunded = await api().get(`${A}/returns?tab=refunded`).set(bearer(admin));
    expect(refunded.body.meta.kpis.refunded30d).toBeGreaterThanOrEqual(expected);
    await settle();
    expect(mail.outbox!.filter((m) => m.to === c.email && m.subject.includes(created.body.data.number)).length).toBeGreaterThanOrEqual(5);
    expect(await prisma.auditEvent.count({ where: { entity: "return", entityId: id } })).toBeGreaterThanOrEqual(4);
  });

  it("rejects with a reason the customer sees; items become returnable again", async () => {
    const c = await registerCustomer();
    const p = await pickProduct("footwear");
    const o = await deliveredOrder(c, [{ p, qty: 1 }]);
    const created = await requestReturn(c, { orderId: o.id, items: [{ orderItemId: o.items[0].id, qty: 1 }], reason: "Authenticity concern" });
    const id = created.body.data.id;
    const inv = await api().post(`${A}/returns/${id}/investigate`).set(bearer(admin)).send({ note: "Sent to authentication team" });
    expect(inv.body.data.status).toBe("Under investigation");
    expect(inv.body.data.inspectorNote).toBe("Sent to authentication team");
    expect((await api().post(`${A}/returns/${id}/reject`).set(bearer(admin)).send({})).status).toBe(400);
    const rj = await api().post(`${A}/returns/${id}/reject`).set(bearer(admin)).send({ reason: "Item verified authentic" });
    expect(rj.status).toBe(200);
    expect(rj.body.data.status).toBe("Rejected");
    const mine = await api().get(`${S}/me/returns/${id}`).set(bearer(c.token));
    expect(mine.body.data.status).toBe("Rejected");
    expect(mine.body.data.statusNote).toBe("Rejected: Item verified authentic");
    expect(mine.body.data.cancelled).toBe(false);
    const r = await api().get(`${S}/me/orders/${o.id}/returnable`).set(bearer(c.token));
    expect(r.body.data.items[0].returnable).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("delivered");
  });

  it("admin creates an RMA for a customer; support can view but not refund", async () => {
    const c = await registerCustomer();
    const a = await pickProduct("clothing");
    const b = await pickProduct("footwear");
    const o = await deliveredOrder(c, [{ p: a, qty: 1 }, { p: b, qty: 1 }]);
    const created = await api().post(`${A}/returns`).set(bearer(admin)).send({ orderId: o.number, reason: "Size too small" });
    expect(created.status).toBe(201);
    expect(created.body.data.items).toBe(2);
    expect(created.body.data.status).toBe("Awaiting review");
    expect(created.body.data.refund).toBe(o.items.reduce((n, i) => n + i.unitPrice * i.qty, 0));
    // everything is already in this RMA
    expect((await api().post(`${A}/returns`).set(bearer(admin)).send({ orderId: o.id, reason: "Again" })).status).toBe(400);
    const id = created.body.data.id;

    expect((await api().get(`${A}/returns`).set(bearer(support))).status).toBe(200);
    expect((await api().get(`${A}/returns/${id}`).set(bearer(support))).status).toBe(200);
    expect((await api().post(`${A}/returns/${id}/approve`).set(bearer(support)).send({})).status).toBe(403);
    expect((await api().post(`${A}/returns/${id}/refund`).set(bearer(support)).send({ to: "original" })).status).toBe(403);
    expect((await api().post(`${A}/returns`).set(bearer(support)).send({ orderId: o.id, reason: "x1" })).status).toBe(403);
    expect((await api().get(`${S}/me/returns`).set(bearer(c.token))).body.data[0].id).toBe(id);

    // partial refund to the original card keeps the order "partially refunded"
    await api().post(`${A}/returns/${id}/approve`).set(bearer(admin)).send({});
    await api().post(`${A}/returns/${id}/received`).set(bearer(admin)).send({ restock: false });
    const rf = await api().post(`${A}/returns/${id}/refund`).set(bearer(admin)).send({ to: "original", amount: N(5_000), note: "Goodwill partial" });
    expect(rf.status).toBe(200);
    expect(rf.body.data.refund).toBe(N(5_000));
    expect(rf.body.data.restocked).toBe(false);
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: { in: ["succeeded", "partially_refunded"] } } });
    expect(pay.amountRefunded).toBe(N(5_000));
    // both lines fully returned → order "returned"
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("returned");
  });
});
