import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { seedCatalog } from "../../prisma/seed/catalog";
import { activityService } from "@/modules/platform/activity/activity.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;
let support: string;

type Pick = { handle: string; size: string | null; color: string | null; price: number };

async function pickProduct(min: number, max: number): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: min, lte: max } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= 3);
    if (v) return { handle: p.handle, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error("no product in range");
}

const addToBag = (token: string, p: Pick) => api().post(`${S}/cart/items`).set(bearer(token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 });
const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

/** bag → checkout → place → mock pay; returns the order */
async function paidOrder(c: { token: string; email: string }) {
  const p = await pickProduct(N(20_000), N(150_000));
  expect((await addToBag(c.token, p)).status).toBe(201);
  await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678", subscribe: false }, delivery: "ship", address: lagos });
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  const pay = await api().post(`${W}/mock/checkout/${r.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(pay.status).toBe(200);
  await settle();
  return r.body.data.order as { id: string; number: string };
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  support = (await createAdmin("support")).token;
}, 240_000);

describe("activity feed", () => {
  let order: { id: string; number: string };

  it("a paid order writes placed + paid rows", async () => {
    const c = await registerCustomer({ name: "Ada Activity" });
    order = await paidOrder(c);
    const r = await api().get(`${A}/activity`).query({ type: "order.*" }).set(bearer(admin));
    expect(r.status).toBe(200);
    const mine = r.body.data.filter((e: { title: string }) => e.title.includes(order.number));
    const types = mine.map((e: { type: string }) => e.type).sort();
    expect(types).toEqual(["order.paid", "order.placed"]);
    const paid = mine.find((e: { type: string }) => e.type === "order.paid");
    expect(paid.meta).toContain("Ada Activity");
    expect(paid.amount).toBeGreaterThan(0);
    expect(paid.link).toBe(`/orders/${order.id}`);
    expect(r.body.meta.total).toBeGreaterThanOrEqual(2);
  });

  it("filters by type and date range", async () => {
    const only = await api().get(`${A}/activity`).query({ type: "order.paid" }).set(bearer(admin));
    expect(only.body.data.every((e: { type: string }) => e.type === "order.paid")).toBe(true);
    const future = await api().get(`${A}/activity`).query({ from: new Date(Date.now() + 60_000).toISOString() }).set(bearer(admin));
    expect(future.body.data).toHaveLength(0);
  });

  it("finance rows are hidden from a support admin", async () => {
    await activityService.record({ type: "payout.paid", title: "Payout PO-TEST paid", meta: "paystack settlement", amount: N(500_000), link: "/payouts" });
    const sa = await api().get(`${A}/activity`).set(bearer(admin));
    expect(sa.body.data.some((e: { type: string }) => e.type === "payout.paid")).toBe(true);
    const sup = await api().get(`${A}/activity`).set(bearer(support));
    expect(sup.status).toBe(200);
    expect(sup.body.data.some((e: { type: string }) => e.type === "payout.paid")).toBe(false);
    expect(sup.body.data.some((e: { title: string }) => e.title.includes(order.number))).toBe(true); // support has orders.view
    expect(sup.body.meta.types).not.toContain("payout.paid");
    // asking for it explicitly doesn't help
    const asked = await api().get(`${A}/activity`).query({ type: "payout.paid" }).set(bearer(support));
    expect(asked.body.data).toHaveLength(0);
  });

  it("prune keeps 90 days", async () => {
    const old = await prisma.activityEntry.create({ data: { type: "system", title: "old", createdAt: new Date(Date.now() - 91 * 86_400_000) } });
    const recent = await prisma.activityEntry.create({ data: { type: "system", title: "recent", createdAt: new Date(Date.now() - 89 * 86_400_000) } });
    expect(await activityService.prune()).toBeGreaterThanOrEqual(1);
    expect(await prisma.activityEntry.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.activityEntry.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});

describe("app config", () => {
  it("serves config and computes updateRequired from X-App-Version", async () => {
    const patch = await api().patch(`${A}/app/config`).set(bearer(admin)).send({ minSupportedVersion: "2.1.0", latestVersion: "2.3.0", features: { wallet: false } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.features).toMatchObject({ wallet: false, concierge: true }); // merged, not replaced
    expect((await api().patch(`${A}/app/config`).set(bearer(support)).send({ latestVersion: "9.0.0" })).status).toBe(403);
    expect((await api().patch(`${A}/app/config`).set(bearer(admin)).send({ minSupportedVersion: "3.0.0" })).status).toBe(400);

    const old = await api().get(`${S}/app/config`).set("X-App-Version", "2.0.9");
    expect(old.status).toBe(200);
    expect(old.body.data).toMatchObject({ updateRequired: true, updateAvailable: true, minSupportedVersion: "2.1.0", clientVersion: "2.0.9" });
    expect(old.body.data.onboarding.length).toBeGreaterThan(0);
    expect(old.body.data.splash).toHaveProperty("enabled");
    expect(old.body.data.homeSections).toHaveProperty("hero");
    expect(old.body.data.storeUrls).toHaveProperty("ios");
    expect(old.body.data.features.wallet).toBe(false);

    const mid = await api().get(`${S}/app/config`).set("X-App-Version", "2.2");
    expect(mid.body.data).toMatchObject({ updateRequired: false, updateAvailable: true });
    const none = await api().get(`${S}/app/config`);
    expect(none.body.data.updateRequired).toBe(false);

    const audit = await prisma.auditEvent.findFirst({ where: { action: "app_config.updated" } });
    expect(audit).not.toBeNull();
  });

  it("saves cookie consent (guest and signed in)", async () => {
    const anonId = uniq("anon");
    const g = await api().post(`${S}/app/consent`).send({ anonId, choices: { performance: true, functional: false, advertising: false } });
    expect(g.status).toBe(201);
    expect(g.body.data).toMatchObject({ essential: true, performance: true, advertising: false });
    const c = await registerCustomer();
    const s = await api().post(`${S}/app/consent`).set(bearer(c.token)).send({ anonId, choices: { performance: true, functional: true, advertising: true } });
    expect(s.status).toBe(201);
    const rows = await prisma.consentRecord.findMany({ where: { anonId }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].customerId).toBeNull();
    expect(rows[1]).toMatchObject({ customerId: c.customer.id, advertising: true });
    expect((await api().post(`${S}/app/consent`).send({ choices: {} })).status).toBe(400);
  });

  it("download offer: guests 401, once per customer, usable at checkout", async () => {
    expect((await api().post(`${S}/app/download-offer/claim`)).status).toBe(401);
    const c = await registerCustomer();
    const first = await api().post(`${S}/app/download-offer/claim`).set(bearer(c.token));
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ pct: 10, label: "App Download Reward", alreadyClaimed: false, used: false });
    const code = first.body.data.code as string;
    expect(code).toMatch(/^APPDL-/);
    const again = await api().post(`${S}/app/download-offer/claim`).set(bearer(c.token));
    expect(again.body.data).toMatchObject({ code, alreadyClaimed: true });
    expect(await prisma.customerCoupon.count({ where: { customerId: c.customer.id } })).toBe(1);
    await settle();
    expect(await prisma.activityEntry.count({ where: { type: "coupon.minted", title: { contains: code } } })).toBe(1);

    // in "my coupons" and at checkout
    const p = await pickProduct(N(20_000), N(150_000));
    await addToBag(c.token, p);
    const applied = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: code.toLowerCase() });
    expect(applied.status).toBe(200);
    expect(applied.body.data.checkout.totals.discount).toBe(Math.round(p.price * 0.1));

    // another customer can't use it
    const other = await registerCustomer();
    await addToBag(other.token, p);
    expect((await api().post(`${S}/checkout/coupon`).set(bearer(other.token)).send({ code })).status).toBe(400);
  });
});

describe("global search", () => {
  let order: { id: string; number: string };
  let email: string;

  beforeAll(async () => {
    const c = await registerCustomer({ name: "Zainab Searchable" });
    email = c.email;
    order = await paidOrder(c);
  });

  it("finds an order by number and a customer by email", async () => {
    expect((await api().get(`${A}/search/global`).query({ q: "a" }).set(bearer(admin))).status).toBe(400);
    const byNumber = await api().get(`${A}/search/global`).query({ q: order.number }).set(bearer(admin));
    expect(byNumber.status).toBe(200);
    const orders = byNumber.body.data.groups.find((g: { key: string }) => g.key === "orders");
    expect(orders.items[0]).toMatchObject({ id: order.id, title: order.number, link: `/orders/${order.id}` });

    const byEmail = await api().get(`${A}/search/global`).query({ q: email }).set(bearer(admin));
    const customers = byEmail.body.data.groups.find((g: { key: string }) => g.key === "customers");
    expect(customers.items).toHaveLength(1);
    expect(customers.items[0].title).toBe("Zainab Searchable");
    expect(customers.items[0].link).toMatch(/^\/customers\?id=/);
    // the same email also finds their order
    expect(byEmail.body.data.groups.find((g: { key: string }) => g.key === "orders").items[0].id).toBe(order.id);

    const byName = await api().get(`${A}/search/global`).query({ q: "zainab search" }).set(bearer(admin));
    expect(byName.body.data.groups.find((g: { key: string }) => g.key === "customers").items).toHaveLength(1);

    const prod = await prisma.product.findFirstOrThrow({ where: { status: "active" }, include: { variants: { take: 1 } } });
    const bySku = await api().get(`${A}/search/global`).query({ q: prod.variants[0].sku }).set(bearer(admin));
    expect(bySku.body.data.groups.find((g: { key: string }) => g.key === "products").items.map((i: { id: string }) => i.id)).toContain(prod.id);
  });

  it("hides groups the role can't view", async () => {
    const catalog = (await createAdmin("catalog_manager")).token;
    const r = await api().get(`${A}/search/global`).query({ q: order.number }).set(bearer(catalog));
    expect(r.status).toBe(200);
    expect(r.body.data.groups.find((g: { key: string }) => g.key === "orders")).toBeUndefined();
    const e = await api().get(`${A}/search/global`).query({ q: email }).set(bearer(catalog));
    expect(e.body.data.groups).toHaveLength(0); // no orders.view, no customers.view
  });
});
