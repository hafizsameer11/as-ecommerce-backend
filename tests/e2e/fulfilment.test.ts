import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { mail } from "@/providers/mail/mail";
import { sms } from "@/providers/sms/sms";
import { seedCatalog } from "../../prisma/seed/catalog";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;
const lagos = { fullName: "Ada Obi", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function pickProduct() {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(140_000) } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= 3);
    if (v) return { handle: p.handle, size: v.size, color: v.color };
  }
  throw new Error("no product");
}

/** places + pays an order; returns the order row */
async function buy(c: { token: string; email: string }, delivery: { delivery: "ship"; address: typeof lagos } | { delivery: "pickup"; pickupLocationId: string }, phone = "+2348012345678") {
  const p = await pickProduct();
  expect((await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 })).status).toBe(201);
  const upd = await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone }, ...delivery });
  expect(upd.status).toBe(200);
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  const pay = await api().post(`${W}/mock/checkout/${r.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(pay.status).toBe(200);
  await settle();
  return prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
}

const advance = (id: string, status: string, location = "Lagos Hub", note?: string) =>
  api().post(`${A}/shipments/${id}/advance`).set(bearer(admin)).send({ status, location, note });

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 240_000);

describe("shipments", () => {
  it("fulfil a paid order → advance to delivered drives the order + emails the customer", async () => {
    const c = await registerCustomer();
    const o = await buy(c, { delivery: "ship", address: lagos });
    expect(o.status).toBe("paid");
    const confirmed = mail.outbox!.find((m) => m.to === c.email && m.subject === `Order ${o.number} confirmed`);
    expect(confirmed).toBeTruthy();
    expect(confirmed!.html).toContain(`${env.WEB_URL}/account/orders/${o.number}`);

    const f = await api().post(`${A}/orders/${o.id}/fulfil`).set(bearer(admin)).send({ carrier: "In-house", service: "Same day", trackingNumber: "TRK-1234", weightKg: 1.2, insured: true });
    expect(f.status).toBe(201);
    const shp = f.body.data;
    expect(shp.number).toMatch(/^SHP-\d+$/);
    expect(shp.carrier).toBe("InHouse");
    expect(shp.carrierLabel).toBe("In-house");
    expect(shp.status).toBe("label_created");
    expect(shp.destination).toContain("Lekki");
    expect(shp.declaredValue).toBe(o.subtotal);
    expect(shp.itemsCount).toBe(1);
    expect(shp.events).toHaveLength(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("processing");

    // invalid move
    const bad = await advance(shp.id, "delivered");
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("INVALID_STATE");

    expect((await advance(shp.id, "picked_up")).body.data.status).toBe("picked_up");
    await settle();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("shipped");
    const shippedMail = mail.outbox!.find((m) => m.to === c.email && m.subject.includes(`${o.number} is on its way`));
    expect(shippedMail?.text).toContain("TRK-1234");
    expect(shippedMail?.text).toContain("In-house");

    // exception flow: in transit → exception → back in transit
    expect((await advance(shp.id, "in_transit", "Ikeja Sortation")).status).toBe(200);
    expect((await advance(shp.id, "exception", "Ikeja Sortation", "Address unclear")).body.data.status).toBe("exception");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("shipped");
    const list = await api().get(`${A}/shipments?tab=exception`).set(bearer(admin));
    expect(list.body.data.map((s: any) => s.id)).toContain(shp.id);
    expect(list.body.meta.kpis.exceptions).toBe(1);
    expect(list.body.meta.tabs.exception).toBe(1);
    expect((await advance(shp.id, "in_transit", "Lekki Depot", "Address confirmed")).body.data.status).toBe("in_transit");

    expect((await advance(shp.id, "out_for_delivery", "Lekki Depot")).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("out_for_delivery");
    const done = await advance(shp.id, "delivered", "Lekki Phase 1", "Signed by Ada");
    expect(done.status).toBe(200);
    expect(done.body.data.deliveredAt).toBeTruthy();
    expect(done.body.data.events.map((e: any) => e.status)).toEqual(["label_created", "picked_up", "in_transit", "exception", "in_transit", "out_for_delivery", "delivered"]);
    await settle();
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(ord.status).toBe("delivered");
    expect(ord.deliveredAt).toBeTruthy();

    const mine = await api().get(`${S}/me/orders/${o.number}`).set(bearer(c.token));
    expect(mine.body.data.status).toBe("Delivered");
    expect(mine.body.data.canReturn).toBe(true);
    expect(mine.body.data.timeline.map((e: any) => e.type)).toEqual(["placed", "payment_confirmed", "processing", "shipped", "out_for_delivery", "delivered"]);

    // finished shipments can't move or be deleted
    expect((await advance(shp.id, "in_transit")).status).toBe(409);
    expect((await api().delete(`${A}/shipments/${shp.id}`).set(bearer(admin))).status).toBe(409);

    // admin list: search + KPIs
    const found = await api().get(`${A}/shipments?q=TRK-1234`).set(bearer(admin));
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0].orderNumber).toBe(o.number);
    expect(found.body.meta.kpis.delivered30d).toBeGreaterThanOrEqual(1);
    expect(typeof found.body.meta.kpis.avgDeliveryDays).toBe("number");

    // customer tracking: owner, other customer, guest token
    const tr = await api().get(`${S}/me/orders/${o.number}/tracking`).set(bearer(c.token));
    expect(tr.status).toBe(200);
    expect(tr.body.data.status).toBe("Delivered");
    expect(tr.body.data.shipments[0].trackingNumber).toBe("TRK-1234");
    expect(tr.body.data.shipments[0].carrierLabel).toBe("In-house");
    expect(tr.body.data.shipments[0].events[0].status).toBe("delivered"); // newest first
    expect(tr.body.data.pickup).toBeNull();
    const other = await registerCustomer();
    expect((await api().get(`${S}/me/orders/${o.id}/tracking`).set(bearer(other.token))).status).toBe(404);
    const byToken = await api().get(`${S}/orders/by-token/${o.accessToken}/tracking`);
    expect(byToken.status).toBe(200);
    expect(byToken.body.data.number).toBe(o.number);
  });

  it("PATCH, delete while label created, and only paid/processing orders can be fulfilled", async () => {
    const c = await registerCustomer();
    const o = await buy(c, { delivery: "ship", address: lagos });
    const f = await api().post(`${A}/shipments`).set(bearer(admin)).send({ orderId: o.number, carrier: "GIG", service: "Standard" });
    expect(f.status).toBe(201);
    const p = await api().patch(`${A}/shipments/${f.body.data.number}`).set(bearer(admin)).send({ trackingNumber: "GIG-441290", etaAt: new Date(Date.now() + 86_400_000).toISOString(), notes: "Fragile" });
    expect(p.status).toBe(200);
    expect(p.body.data.tracking).toBe("GIG-441290");
    expect(p.body.data.notes).toBe("Fragile");
    const del = await api().delete(`${A}/shipments/${f.body.data.id}`).set(bearer(admin));
    expect(del.status).toBe(200);
    expect(await prisma.shipment.count({ where: { orderId: o.id } })).toBe(0);

    // cancel by admin → can't fulfil any more; customer gets the cancellation email
    expect((await api().post(`${A}/orders/${o.id}/cancel`).set(bearer(admin)).send({ reason: "Customer asked" })).status).toBe(200);
    await settle();
    expect(mail.outbox!.some((m) => m.to === c.email && m.subject === `Order ${o.number} cancelled`)).toBe(true);
    const r = await api().post(`${A}/orders/${o.id}/fulfil`).set(bearer(admin)).send({ carrier: "DHL", service: "Express" });
    expect(r.status).toBe(409);
  });
});

describe("pick-up bookings", () => {
  it("paid pick-up order → booking; ready → SMS; collected → order delivered", async () => {
    const loc = await prisma.pickupLocation.findFirstOrThrow({ where: { active: true } });
    const c = await registerCustomer();
    // SMS to account holders follows their preferences (off by default)
    await api().put(`${S}/me/notification-preferences`).set(bearer(c.token)).send({ channels: { sms: true } });
    const phone = "+2348099990001";
    const o = await buy(c, { delivery: "pickup", pickupLocationId: loc.id }, phone);
    const b = await prisma.pickupBooking.findUniqueOrThrow({ where: { orderId: o.id } });
    expect(b.number).toMatch(/^PU-\d+$/);
    expect(b.status).toBe("scheduled");
    // next day 12:00 Lagos (UTC+1)
    const lagosToday = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    const expected = new Date(Date.parse(`${lagosToday}T11:00:00Z`) + 86_400_000);
    expect(b.scheduledAt.toISOString()).toBe(expected.toISOString());

    // idempotent: replaying order.paid doesn't create a second booking
    const { pickupsService } = await import("@/modules/fulfilment/pickups/pickups.service");
    await pickupsService.createBookingForOrder(o.id);
    expect(await prisma.pickupBooking.count({ where: { orderId: o.id } })).toBe(1);

    // shipments are refused for pick-up orders
    const ship = await api().post(`${A}/orders/${o.id}/fulfil`).set(bearer(admin)).send({ carrier: "DHL", service: "Express" });
    expect(ship.status).toBe(409);
    expect(ship.body.error.message).toContain(b.number);

    const list = await api().get(`${A}/pickups/bookings?tab=scheduled&locationId=${loc.id}`).set(bearer(admin));
    expect(list.status).toBe(200);
    const row = list.body.data.find((x: any) => x.id === b.id);
    expect(row.orderNumber).toBe(o.number);
    expect(row.customerPhone).toBe(phone);
    expect(row.itemsCount).toBe(1);
    expect(list.body.meta.tabs.scheduled).toBeGreaterThanOrEqual(1);
    const byDay = await api().get(`${A}/pickups/bookings?date=${expected.toISOString().slice(0, 10)}`).set(bearer(admin));
    expect(byDay.body.data.map((x: any) => x.id)).toContain(b.id);

    expect((await api().post(`${A}/pickups/bookings/${b.id}/advance`).set(bearer(admin)).send({ status: "collected" })).status).toBe(409);
    expect((await api().post(`${A}/pickups/bookings/${b.id}/notes`).set(bearer(admin)).send({ note: "Gift wrap requested." })).body.data.notes).toBe("Gift wrap requested.");

    // asl-admin paths: /pickups/locations + advance { action, note }
    const locs = await api().get(`${A}/pickups/locations`).set(bearer(admin));
    expect(locs.status).toBe(200);
    expect(locs.body.data.find((x: any) => x.id === loc.id)?.bookingsLast30).toBeGreaterThanOrEqual(1);
    expect((await api().get(`${A}/pickup-locations`).set(bearer(admin))).status).toBe(200);

    const before = sms.outbox.length;
    const ready = await api().post(`${A}/pickups/bookings/${b.number}/advance`).set(bearer(admin)).send({ action: "ready", note: "Counter 2" });
    expect(ready.status).toBe(200);
    expect(ready.body.data.status).toBe("ready");
    expect(ready.body.data.notes).toBe("Counter 2");
    await settle();
    const text = sms.outbox.slice(before).find((m) => m.to === phone);
    expect(text?.body).toContain(o.number);
    expect(text?.body).toContain(loc.name);
    const mid = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { events: true } });
    expect(mid.status).toBe("processing");
    expect(mid.events.some((e) => e.type === "ready_for_pickup")).toBe(true);

    const tr = await api().get(`${S}/me/orders/${o.number}/tracking`).set(bearer(c.token));
    expect(tr.body.data.pickup.number).toBe(b.number);
    expect(tr.body.data.pickup.statusLabel).toBe("Ready for pick-up");
    expect(tr.body.data.pickup.location.name).toBe(loc.name);

    const col = await api().post(`${A}/pickups/bookings/${b.id}/advance`).set(bearer(admin)).send({ status: "collected", collectedBy: "Ada Obi (ID checked)" });
    expect(col.status).toBe(200);
    expect(col.body.data.collectedBy).toBe("Ada Obi (ID checked)");
    expect(col.body.data.collectedAt).toBeTruthy();
    await settle();
    const done = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(done.status).toBe("delivered");
    expect(done.deliveredAt).toBeTruthy();
    const mine = await api().get(`${S}/me/orders/${o.number}`).set(bearer(c.token));
    expect(mine.body.data.status).toBe("Delivered");
    expect(mine.body.data.pickupBooking.status).toBe("collected");
    expect((await api().post(`${A}/pickups/bookings/${b.id}/advance`).set(bearer(admin)).send({ status: "ready" })).status).toBe(409);
  });

  it("books the first day with capacity and refuses reschedules into a full day", async () => {
    const loc = await prisma.pickupLocation.findFirstOrThrow({ where: { active: true } });
    const used = await prisma.pickupBooking.count({ where: { locationId: loc.id, status: { in: ["scheduled", "ready", "collected"] } } });
    await prisma.pickupLocation.update({ where: { id: loc.id }, data: { capacityPerDay: Math.max(1, used) } });
    try {
      const first = await prisma.pickupBooking.findFirstOrThrow({ where: { locationId: loc.id } });
      const c = await registerCustomer();
      const o = await buy(c, { delivery: "pickup", pickupLocationId: loc.id });
      const b = await prisma.pickupBooking.findUniqueOrThrow({ where: { orderId: o.id } });
      // tomorrow is full → day after
      expect(b.scheduledAt.getTime() - first.scheduledAt.getTime()).toBe(86_400_000);

      const full = await api().patch(`${A}/pickups/bookings/${b.id}`).set(bearer(admin)).send({ scheduledAt: first.scheduledAt.toISOString() });
      expect(full.status).toBe(409);
      const later = new Date(first.scheduledAt.getTime() + 3 * 86_400_000);
      const ok = await api().patch(`${A}/pickups/bookings/${b.id}`).set(bearer(admin)).send({ scheduledAt: later.toISOString() });
      expect(ok.status).toBe(200);
      expect(new Date(ok.body.data.scheduledAt).getTime()).toBe(later.getTime());

      // cancelling the order frees the slot
      expect((await api().post(`${S}/me/orders/${o.id}/cancel`).set(bearer(c.token)).send({})).status).toBe(200);
      await settle();
      expect((await prisma.pickupBooking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("cancelled");
    } finally {
      await prisma.pickupLocation.update({ where: { id: loc.id }, data: { capacityPerDay: 40 } });
    }
  });
});
