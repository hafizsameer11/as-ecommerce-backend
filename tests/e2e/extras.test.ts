import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { seedCatalog } from "../../prisma/seed/catalog";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;
let alice: Awaited<ReturnType<typeof registerCustomer>>;

const address = { fullName: "Alice Ade", phone: "+2348012345678", address: "12 Admiralty Way", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  expect(r.status).toBe(200);
  await settle();
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  alice = await registerCustomer({ name: "Alice Ade" });
}, 240_000);

// ─────────────────────────── concierge cart ───────────────────────────
describe("concierge cart: edit, remove, combined checkout", () => {
  const ids: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
  let checkoutId = "";

  const submit = async (itemName: string) => {
    const r = await api().post(`${S}/concierge/requests`).set(bearer(alice.token))
      .field("itemName", itemName).field("category", "Footwear").field("brand", "Jordan").field("size", "UK 9");
    expect(r.status).toBe(201);
    return r.body.data.id as string;
  };
  const quote = (id: string, price: number, extra: Record<string, unknown> = {}) =>
    api().post(`${A}/concierge/requests/${id}/quotes`).set(bearer(admin)).send({ lines: [{ name: "Item", qty: 1, price }], ...extra });
  const patch = (id: string, body: Record<string, unknown>) => api().patch(`${S}/concierge/cart/items/${id}`).set(bearer(alice.token)).send(body);
  const checkout = (body: Record<string, unknown>) => api().post(`${S}/concierge/checkout`).set(bearer(alice.token)).set("Idempotency-Key", uniq("idem")).send(body);

  it("sets up three requests: two quoted, one still sourcing", async () => {
    ids.a = await submit("AJ1 Black Toe");
    ids.b = await submit("Keepall 50");
    ids.c = await submit("Logo Hoodie");
    expect((await quote(ids.a, N(280_000))).status).toBe(201);
    expect((await quote(ids.b, N(500_000), { depositPct: 50 })).status).toBe(201);
    const cart = await api().get(`${S}/concierge/cart`).set(bearer(alice.token));
    expect(cart.body.data.count).toBe(3);
  });

  it("edits qty on a sourcing item: timeline entry, nothing withdrawn", async () => {
    const r = await patch(ids.c, { qty: 2, notes: "Black please" });
    expect(r.status).toBe(200);
    expect(r.body.data.item.qty).toBe(2);
    expect(r.body.data.quoteWithdrawn).toBeNull();
    expect(r.body.data.changed).toContain("qty 1 → 2");
    const tl = await prisma.conciergeTimelineEntry.findMany({ where: { requestId: ids.c, by: "Customer" } });
    expect(tl.some((t) => t.text.includes("qty 1 → 2"))).toBe(true);
    // no change → no new entry
    const again = await patch(ids.c, { qty: 2 });
    expect(again.body.data.changed).toEqual([]);
    expect(await prisma.conciergeTimelineEntry.count({ where: { requestId: ids.c, by: "Customer" } })).toBe(tl.length);
    expect((await patch(ids.c, {})).status).toBe(400);
  });

  it("changing the size after a quote withdraws the quote and goes back to sourcing", async () => {
    const r = await patch(ids.b, { size: "UK 10" });
    expect(r.status).toBe(200);
    expect(r.body.data.quoteWithdrawn).toMatch(/^QT-/);
    expect(r.body.data.item.statusKey).toBe("sourcing");
    const q = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.b } });
    expect(q.status).toBe("expired");
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { requestId: ids.b } });
    expect(thread.unreadAgent).toBeGreaterThan(0);
    // staff re-quote at 50 % deposit
    expect((await quote(ids.b, N(500_000), { depositPct: 50 })).status).toBe(201);
  });

  it("checkout summary: deposit lines for quoted items, the sourcing item is not payable", async () => {
    const r = await api().get(`${S}/concierge/checkout`).set(bearer(alice.token));
    expect(r.status).toBe(200);
    expect(r.body.data.count).toBe(2);
    expect(r.body.data.notPayable.map((x: { requestId: string }) => x.requestId)).toEqual([ids.c]);
    const qa = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.a } });
    const qb = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.b, status: "sent" } });
    expect(r.body.data.amount).toBe(qa.deposit + qb.deposit);
    expect(qb.deposit).toBeLessThan(qb.total);
  });

  it("refuses an explicit selection containing an unquoted item", async () => {
    const r = await checkout({ requestIds: [ids.a, ids.c], address });
    expect(r.status).toBe(409);
    expect(r.body.error.details.items[0].requestId).toBe(ids.c);
  });

  it("pays both quotes in one payment: A ordered, B approved with balance due, journal to 2200", async () => {
    const r = await checkout({ address, phone: "+2348099999999" });
    expect(r.status).toBe(200);
    const qa = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.a } });
    const qb = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.b, status: "accepted" } });
    expect(r.body.data.payment.amount).toBe(qa.deposit + qb.deposit);
    expect(r.body.data.checkout.items).toHaveLength(2);
    checkoutId = r.body.data.checkout.id;
    const reqB = await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: ids.b } });
    expect(reqB.status).toBe("payment_pending");
    expect(reqB.contactPhone).toBe("+2348099999999");
    expect((reqB.deliveryAddress as { city: string }).city).toBe("Lekki");

    await payMock(r.body.data.payment.reference);
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: ids.a } })).status).toBe("ordered");
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: ids.b } })).status).toBe("approved");
    const paidB = await prisma.conciergeQuote.findUniqueOrThrow({ where: { id: qb.id } });
    expect(paidB.amountPaid).toBe(qb.deposit);

    const je = await prisma.journalEntry.findFirst({ where: { reference: r.body.data.payment.reference, source: "order" }, include: { lines: true } });
    expect(je).toBeTruthy();
    expect(Number(je!.lines.find((l) => l.accountCode === "2200")!.credit)).toBe(qa.deposit + qb.deposit);

    const res = await api().get(`${S}/concierge/checkout/${checkoutId}`).set(bearer(alice.token));
    expect(res.body.data.payment.status).toBe("succeeded");
    expect(res.body.data.items.map((i: { request: { statusKey: string } }) => i.request.statusKey).sort()).toEqual(["approved", "ordered"]);
  });

  it("second checkout pays B's balance only", async () => {
    const pre = await api().get(`${S}/concierge/checkout`).set(bearer(alice.token));
    expect(pre.body.data.items).toHaveLength(1);
    expect(pre.body.data.items[0].kind).toBe("balance");
    const r = await checkout({});
    expect(r.status).toBe(200);
    await payMock(r.body.data.payment.reference);
    const qb = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.b, status: "paid" } });
    expect(qb.amountPaid).toBe(qb.total);
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: ids.b } })).status).toBe("ordered");
  });

  it("staff refund on A goes back through the shared checkout payment", async () => {
    const qa = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: ids.a } });
    const r = await api().post(`${A}/concierge/requests/${ids.a}/refund`).set(bearer(admin)).send({ amount: N(10_000), reason: "Price drop" });
    expect(r.status).toBe(200);
    expect(r.body.data.refunded).toBe(N(10_000));
    const line = await prisma.conciergeCheckoutLine.findFirstOrThrow({ where: { checkoutId, quoteId: qa.id } });
    expect(line.refunded).toBe(N(10_000));
    const pay = await prisma.payment.findFirstOrThrow({ where: { targetType: "concierge_checkout", targetId: checkoutId } });
    expect(pay.amountRefunded).toBe(N(10_000));
    // can't refund more for A than A's share of the payment
    const tooMuch = await api().post(`${A}/concierge/requests/${ids.a}/refund`).set(bearer(admin)).send({ amount: qa.total, reason: "x refund", cancelRequest: true });
    expect(tooMuch.status).toBe(400);
  });

  it("money for a quote withdrawn after checkout opened is refunded; the other line still applies", async () => {
    const d = await submit("Dunk Low");
    const e = await submit("Samba OG");
    await quote(d, N(100_000));
    await quote(e, N(120_000));
    const r = await checkout({ requestIds: [d, e], address });
    expect(r.status).toBe(200);
    const qd = await prisma.conciergeQuote.findFirstOrThrow({ where: { requestId: d } });
    expect((await api().post(`${A}/concierge/quotes/${qd.id}/withdraw`).set(bearer(admin)).send({ reason: "Sold out" })).status).toBe(200);
    // the checkout payment was abandoned, but the gateway still captures it
    expect((await prisma.payment.findUniqueOrThrow({ where: { reference: r.body.data.payment.reference } })).status).toBe("abandoned");
    await payMock(r.body.data.payment.reference);
    const pay = await prisma.payment.findUniqueOrThrow({ where: { reference: r.body.data.payment.reference } });
    expect(pay.amountRefunded).toBe(qd.deposit);
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: e } })).status).toBe("ordered");
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: d } })).status).toBe("sourcing");
    const line = await prisma.conciergeCheckoutLine.findFirstOrThrow({ where: { quoteId: qd.id } });
    expect(line.refunded).toBe(qd.deposit);
  });

  it("paid items can't be edited or removed; unpaid ones are cancelled; closed ones are a no-op", async () => {
    expect((await patch(ids.a, { qty: 3 })).status).toBe(409);
    expect((await api().delete(`${S}/concierge/cart/items/${ids.a}`).set(bearer(alice.token))).status).toBe(200); // ordered: not in the cart any more
    const del = await api().delete(`${S}/concierge/cart/items/${ids.c}`).set(bearer(alice.token)).send({ reason: "Changed my mind" });
    expect(del.status).toBe(200);
    expect(del.body.data.action).toBe("cancelled");
    expect(del.body.data.request.statusKey).toBe("cancelled");
    const again = await api().delete(`${S}/concierge/cart/items/${ids.c}`).set(bearer(alice.token));
    expect(again.body.data.action).toBe("none");
    expect((await api().delete(`${S}/concierge/cart/items/nope`).set(bearer(alice.token))).status).toBe(404);
  });

  it("clear cart cancels unpaid items and keeps paid ones", async () => {
    const f = await submit("Tabi boots");
    const g = await submit("Birkin 25");
    await quote(g, N(900_000), { depositPct: 50 });
    const r = await checkout({ requestIds: [g], address });
    await payMock(r.body.data.payment.reference); // g approved (deposit paid)
    const clear = await api().post(`${S}/concierge/cart/clear`).set(bearer(alice.token));
    expect(clear.status).toBe(200);
    const fNum = (await prisma.conciergeRequest.findUniqueOrThrow({ where: { id: f } })).number;
    expect(clear.body.data.cancelled).toContain(fNum);
    expect(clear.body.data.kept.map((k: { requestId: string }) => k.requestId)).toEqual([g]);
    const cart = await api().get(`${S}/concierge/cart`).set(bearer(alice.token));
    expect(cart.body.data.items.map((i: { id: string }) => i.id)).toEqual([g]);
  });
});

// ─────────────────────────── shipments: labels, carrier webhook, export ───────────────────────────
const lagos = { fullName: "Ada Obi", address: "12 Admiralty Way", apartment: "Flat 3", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function pickProduct() {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(140_000) } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, st) => n + st.onHand - st.reserved, 0) >= 3);
    if (v) return { handle: p.handle, size: v.size, color: v.color };
  }
  throw new Error("no product");
}

async function paidOrder() {
  const c = await registerCustomer();
  const p = await pickProduct();
  expect((await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 })).status).toBe(201);
  expect((await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos })).status).toBe(200);
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  await payMock(r.body.data.payment.reference);
  return prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
}

const pdfPages = (buf: Buffer) => (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
const binary = (res: import("superagent").Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("shipping labels, carrier webhook, shipments export", () => {
  const shp: { id: string; number: string; order: string }[] = [];
  const SECRET = "carrier-secret-0123456789";
  const hook = (carrier: string, body: Record<string, unknown>, secret: string | null = SECRET) => {
    const r = api().post(`/api/v1/webhooks/carriers/${carrier}`);
    if (secret) r.set("X-Carrier-Secret", secret);
    return r.send(body);
  };

  beforeAll(async () => {
    (env as { CARRIER_WEBHOOK_SECRET?: string }).CARRIER_WEBHOOK_SECRET = SECRET;
    for (const [i, opts] of [{ insured: true, signatureRequired: true }, { insured: false }].entries()) {
      const o = await paidOrder();
      const f = await api().post(`${A}/orders/${o.id}/fulfil`).set(bearer(admin)).send({ carrier: "DHL", service: "Express", trackingNumber: `JD0146${i}0`, weightKg: 1.25, ...opts });
      expect(f.status).toBe(201);
      shp.push({ id: f.body.data.id, number: f.body.data.number, order: o.number });
    }
  }, 120_000);

  it("prints one PDF with a 4x6 page per shipment", async () => {
    const r = await api().post(`${A}/shipments/labels`).set(bearer(admin)).send({ ids: [shp[0].id, shp[1].number] }).buffer(true).parse(binary);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/pdf");
    const buf = r.body as Buffer;
    expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdfPages(buf)).toBe(2);
    expect(buf.toString("latin1")).toMatch(/MediaBox \[0 0 288 432\]/);
    const missing = await api().post(`${A}/shipments/labels`).set(bearer(admin)).send({ ids: [shp[0].id, "SHP-NOPE"] });
    expect(missing.status).toBe(404);
    expect(missing.body.error.details.missing).toEqual(["SHP-NOPE"]);
  });

  it("single label by id or number", async () => {
    const r = await api().get(`${A}/shipments/${shp[0].number}/label.pdf`).set(bearer(admin)).buffer(true).parse(binary);
    expect(r.status).toBe(200);
    expect(pdfPages(r.body as Buffer)).toBe(1);
    expect(r.headers["content-disposition"]).toContain(`label-${shp[0].number}.pdf`);
    expect((await api().get(`${A}/shipments/${shp[0].id}/label.pdf`)).status).toBe(401);
  });

  it("Code128 helper renders a PNG", async () => {
    const { code128 } = await import("@/modules/fulfilment/shipment-labels/labels.render");
    const png = await code128(shp[0].number);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  it("carrier webhook: secret required, unknown tracking ignored", async () => {
    expect((await hook("dhl", { trackingNumber: "JD014600", status: "picked_up" }, null)).status).toBe(401);
    expect((await hook("dhl", { trackingNumber: "JD014600", status: "picked_up" }, "wrong-secret-0123456789")).status).toBe(401);
    expect((await hook("pigeon", { trackingNumber: "JD014600", status: "picked_up" })).status).toBe(404);
    const r = await hook("dhl", { trackingNumber: "NOPE123", status: "picked_up" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ applied: false, reason: "unknown_tracking_number" });
  });

  it("carrier webhook advances the shipment + order; duplicates and out-of-order events are ignored", async () => {
    const t0 = Date.now() - 3 * 3_600_000;
    const at = (h: number) => new Date(t0 + h * 3_600_000).toISOString();
    const pick = await hook("DHL", { trackingNumber: "JD014600", status: "Picked Up", location: "Lagos Gateway", occurredAt: at(0) });
    expect(pick.body.data).toMatchObject({ applied: true, status: "picked_up" });
    const dup = await hook("DHL", { trackingNumber: "JD014600", status: "Picked Up", location: "Lagos Gateway", occurredAt: at(0) });
    expect(dup.body.data).toMatchObject({ applied: false, reason: "duplicate" });
    expect((await hook("DHL", { trackingNumber: "JD014600", status: "in_transit", location: "Lagos Hub", occurredAt: at(1) })).body.data.applied).toBe(true);
    expect((await hook("DHL", { trackingNumber: "JD014600", status: "out_for_delivery", location: "Lekki", occurredAt: at(2) })).body.data.applied).toBe(true);
    // a late "in transit" scan from before out-for-delivery
    const late = await hook("DHL", { trackingNumber: "JD014600", status: "in_transit", location: "Ikeja", occurredAt: at(1.5) });
    expect(late.body.data).toMatchObject({ applied: false, reason: "out_of_order" });
    // a move the rules don't allow
    const back = await hook("DHL", { trackingNumber: "JD014600", status: "picked_up", occurredAt: at(2.5) });
    expect(back.body.data.applied).toBe(false);
    expect(back.body.data.reason).toMatch(/^not_allowed/);
    const del = await hook("DHL", { trackingNumber: "JD014600", status: "delivered", location: "Lekki", note: "Signed by Ada", occurredAt: at(3) });
    expect(del.body.data.applied).toBe(true);
    await settle();
    const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shp[0].id }, include: { events: true } });
    expect(s.status).toBe("delivered");
    expect(s.events.map((e) => e.status)).toEqual(["label_created", "picked_up", "in_transit", "out_for_delivery", "delivered"]);
    const o = await prisma.order.findFirstOrThrow({ where: { number: shp[0].order } });
    expect(o.status).toBe("delivered");
    const unknown = await hook("DHL", { trackingNumber: "JD014610", status: "teleported" });
    expect(unknown.body.data).toMatchObject({ applied: false, reason: "unknown_status" });
  });

  it("exports shipments as CSV with the list filters", async () => {
    const r = await api().get(`${A}/shipments/export?tab=delivered`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    const lines = r.text.trim().split("\r\n");
    expect(lines[0]).toContain("Shipment,Order,Customer");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(shp[0].number);
    expect(lines[1]).toContain("Delivered");
    const all = await api().get(`${A}/shipments/export`).set(bearer(admin));
    expect(all.text.trim().split("\r\n")).toHaveLength(3);
  });
});

// ─────────────────────────── draft orders CSV import ───────────────────────────
describe("draft orders CSV import", () => {
  let sku = "";
  let handle = "";
  let size = "";
  let color = "";
  let price = 0;
  let bob: Awaited<ReturnType<typeof registerCustomer>>;

  const upload = (csv: string, dryRun = false, filename = "drafts.csv") => {
    const r = api().post(`${A}/draft-orders/import`).set(bearer(admin));
    if (dryRun) r.field("dryRun", "true");
    return r.attach("file", Buffer.from(csv, "utf8"), { filename, contentType: "text/csv" });
  };

  beforeAll(async () => {
    bob = await registerCustomer({ name: "Bob Bello" });
    const p = await prisma.product.findFirstOrThrow({
      where: { status: "active", priceOnRequest: false, deletedAt: null, variants: { some: { active: true, size: { not: null } } } },
      include: { variants: { where: { active: true }, orderBy: { position: "asc" } } },
      orderBy: { handle: "asc" },
    });
    const v = p.variants.find((x) => x.size)!;
    sku = v.sku;
    handle = p.handle;
    size = v.size!;
    color = v.color ?? "";
    price = v.price ?? p.price;
  });

  it("template is a CSV with every column", async () => {
    const r = await api().get(`${A}/draft-orders/import/template`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.text.split("\r\n")[0]).toBe("customerEmail,customerName,email,sku,productHandle,name,size,color,qty,unitPrice,note,groupKey");
    expect(r.text.split("\r\n").filter(Boolean)).toHaveLength(4);
  });

  it("any bad row → nothing created, every error reported with its row", async () => {
    const before = await prisma.draftOrder.count();
    const csv = [
      "customerEmail,customerName,email,sku,productHandle,name,size,color,qty,unitPrice,note,groupKey",
      `${bob.email},,,${sku},,,,,1,,,`, // ok
      "nobody@nowhere.dev,,,,,Custom thing,,,1,5000,,", // unknown customer
      `,Ada Obi,ada@example.com,NOPE-SKU,,,,,1,,,`, // bad sku
      `,Ada Obi,not-an-email,,,Gift wrap,,,1,1000,,`, // bad email
      `,Ada Obi,ada@example.com,,,Custom no price,,,1,,,`, // custom line without price
      `,Ada Obi,ada@example.com,,${handle},,XXL-NOPE,,2,,,`, // bad size
      `,Ada Obi,ada@example.com,,,Box,,,0,1000,,`, // qty 0
      `,Ada Obi,ada@example.com,,,Box,,,1,12abc,,`, // bad price
      `${bob.email},,,,,Wrap,,,1,1000,,g1`,
      `,Ada Obi,ada@example.com,,,Wrap,,,1,1000,,g1`, // same group, other customer
    ].join("\n");
    const r = await upload(csv);
    expect(r.status).toBe(200);
    expect(r.body.data.created).toEqual([]);
    expect(r.body.data.valid).toBe(false);
    const rows = r.body.data.errors.map((e: { row: number }) => e.row);
    expect(rows).toEqual([3, 4, 5, 6, 7, 8, 9, 11]);
    expect(r.body.data.errors.find((e: { row: number }) => e.row === 4).message).toContain("NOPE-SKU");
    expect(r.body.data.errors.find((e: { row: number }) => e.row === 11).column).toBe("groupKey");
    expect(await prisma.draftOrder.count()).toBe(before);
  });

  it("missing columns / empty file / no file", async () => {
    expect((await upload("foo,bar\n1,2")).body.data.errors[0].message).toMatch(/Unknown column|sku, productHandle or name/);
    expect((await upload("")).body.data.errors[0].message).toBe("The file is empty.");
    expect((await api().post(`${A}/draft-orders/import`).set(bearer(admin)).field("dryRun", "true")).status).toBe(400);
  });

  it("creates drafts: groups, catalogue price default, NGN prices, quoted cells, semicolon notes", async () => {
    const before = await prisma.draftOrder.count();
    const csv = [
      "Customer Email,Customer Name,Email,SKU,Product Handle,Name,Size,Colour,Qty,Unit Price,Note,Group Key",
      `${bob.email.toUpperCase()},,,${sku},,,,,2,,"VIP, call first",`,
      `,Ada Obi,ada@example.com,,${handle},,${size},${color},1,"₦125,000.50",Hold till Friday,ada`,
      `,Ada Obi,ada@example.com,,,"Gift wrap ""deluxe""",,,1,5000,,ada`,
    ].join("\r\n");
    const dry = await upload(csv, true);
    expect(dry.body.data).toMatchObject({ valid: true, drafts: 2, created: [] });
    expect(await prisma.draftOrder.count()).toBe(before);

    const r = await upload(csv);
    expect(r.status).toBe(200);
    expect(r.body.data.errors).toEqual([]);
    expect(r.body.data.created).toHaveLength(2);
    expect(await prisma.draftOrder.count()).toBe(before + 2);

    const [b, a] = r.body.data.created;
    expect(b.rows).toEqual([2]);
    const bd = await prisma.draftOrder.findUniqueOrThrow({ where: { id: b.id } });
    expect(bd.customerId).toBe(bob.customer.id);
    expect(bd.total).toBe(price * 2);
    expect(bd.note).toBe("VIP, call first");
    expect(bd.number).toMatch(/^DFT-/);

    expect(a.rows).toEqual([3, 4]);
    const ad = await prisma.draftOrder.findUniqueOrThrow({ where: { id: a.id } });
    expect(ad.customerId).toBeNull();
    expect(ad.email).toBe("ada@example.com");
    const items = ad.items as { name: string; unitPrice: number; custom: boolean; sku: string | null }[];
    expect(items).toHaveLength(2);
    expect(items[0].unitPrice).toBe(12_500_050);
    expect(items[0].custom).toBe(false);
    expect(items[1]).toMatchObject({ name: 'Gift wrap "deluxe"', unitPrice: N(5000), custom: true });
    expect(ad.total).toBe(12_500_050 + N(5000));

    // the drafts work like any other: visible in the list
    const list = await api().get(`${A}/draft-orders?q=Ada`).set(bearer(admin));
    expect(list.body.data.some((d: { id: string }) => d.id === a.id)).toBe(true);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "draft.imported" }, orderBy: { createdAt: "desc" } });
    expect(audit?.summary).toContain(a.number);
  });

  it("needs orders.edit", async () => {
    const analyst = (await createAdmin("analyst")).token;
    expect((await api().get(`${A}/draft-orders/import/template`).set(bearer(analyst))).status).toBe(403);
  });
});
