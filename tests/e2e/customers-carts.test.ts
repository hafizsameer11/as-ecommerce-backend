import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";
import { abandonedCartsService } from "@/modules/commerce/carts/abandoned-carts.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const MIN = 60_000;
const DAY = 86_400_000;

let admin: string;

type Pick = { handle: string; productId: string; size: string | null; color: string | null; price: number };

async function pickProducts(count: number): Promise<Pick[]> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(10_000), lte: N(140_000) } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  const out: Pick[] = [];
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= 5);
    if (v) out.push({ handle: p.handle, productId: p.id, size: v.size, color: v.color, price: v.price ?? p.price });
    if (out.length === count) return out;
  }
  throw new Error("not enough products");
}

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 240_000);

describe("admin customers", () => {
  const tag = uniq("zq");
  let big: Awaited<ReturnType<typeof registerCustomer>>;
  let small: Awaited<ReturnType<typeof registerCustomer>>;

  beforeAll(async () => {
    big = await registerCustomer({ name: `Adaeze ${tag}` });
    small = await registerCustomer({ name: `Bola ${tag}` });
    await prisma.customer.update({ where: { id: big.customer.id }, data: { phone: "+2348031112222", city: "Lagos", country: "NG", tier: "Gold", status: "vip" } });
    const stats = async (customerId: string, data: { ordersCount: number; totalSpend: bigint; aov: number; lastOrderAt?: Date }) =>
      prisma.customerStats.upsert({ where: { customerId }, create: { customerId, ...data }, update: data });
    await stats(big.customer.id, { ordersCount: 4, totalSpend: BigInt(N(2_000_000)), aov: N(500_000), lastOrderAt: new Date() });
    await stats(small.customer.id, { ordersCount: 1, totalSpend: BigInt(N(50_000)), aov: N(50_000) });
  });

  it("lists with tabs, search, sort and tier filter; rows look like the UI Customer", async () => {
    const r = await api().get(`${A}/customers`).query({ q: tag, sort: "-spend" }).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.data.map((c: any) => c.id)).toEqual([big.customer.id, small.customer.id]);
    expect(r.body.meta.tabs).toMatchObject({ all: 2, active: 1, vip: 1, flagged: 0, blocked: 0 });
    const row = r.body.data[0];
    expect(row).toMatchObject({
      name: `Adaeze ${tag}`, email: big.email, phone: "+2348031112222", city: "Lagos", country: "Nigeria", tier: "Gold", status: "vip",
      orders: 4, spend: N(2_000_000), aov: N(500_000), walletBalance: 0, loyaltyPoints: 250, marketingOptIn: false, tags: [], // 250 = sign-up bonus (club.signupBonus)
    });

    const asc = await api().get(`${A}/customers`).query({ q: tag, sort: "spend" }).set(bearer(admin));
    expect(asc.body.data[0].id).toBe(small.customer.id);
    const vip = await api().get(`${A}/customers`).query({ q: tag, tab: "vip" }).set(bearer(admin));
    expect(vip.body.data.map((c: any) => c.id)).toEqual([big.customer.id]);
    const gold = await api().get(`${A}/customers`).query({ q: tag, tier: "Gold" }).set(bearer(admin));
    expect(gold.body.meta.total).toBe(1);
    // full-name search and phone search
    expect((await api().get(`${A}/customers`).query({ q: `Bola ${tag}` }).set(bearer(admin))).body.data[0].id).toBe(small.customer.id);
    expect((await api().get(`${A}/customers`).query({ q: "8031112222" }).set(bearer(admin))).body.data[0].id).toBe(big.customer.id);

    const csv = await api().get(`${A}/customers/export`).query({ q: tag }).set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain(big.email);
    expect(csv.text).toContain("Spend (NGN)");
  });

  it("detail: profile, stats, wallet, addresses, notes, tags, recent orders", async () => {
    await prisma.address.create({ data: { customerId: big.customer.id, label: "Home", recipient: "Adaeze", phone: "+2348031112222", line1: "1 Bourdillon Rd", city: "Ikoyi", state: "Lagos" } });
    const r = await api().get(`${A}/customers/${big.customer.id}`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: big.customer.id, stats: { orders: 4, spend: N(2_000_000) }, wallet: { balance: 0, frozen: false }, notes: [], recentOrders: [] });
    expect(r.body.data.addresses[0]).toMatchObject({ label: "Home", line1: "1 Bourdillon Rd", city: "Ikoyi" });
    expect((await api().get(`${A}/customers/nope`).set(bearer(admin))).status).toBe(404);
  });

  it("tier, marketing, notes and tags (audited)", async () => {
    const id = small.customer.id;
    const t = await api().patch(`${A}/customers/${id}/tier`).set(bearer(admin)).send({ tier: "Silver" });
    expect(t.body.data.tier).toBe("Silver");
    const m = await api().post(`${A}/customers/${id}/marketing`).set(bearer(admin)).send({ optIn: true });
    expect(m.body.data.marketingOptIn).toBe(true);

    const note = await api().post(`${A}/customers/${id}/notes`).set(bearer(admin)).send({ body: "Prefers WhatsApp updates." });
    expect(note.status).toBe(201);
    expect(note.body.data).toMatchObject({ author: "Admin super_admin", body: "Prefers WhatsApp updates." });
    const tagA = await api().post(`${A}/customers/${id}/tags`).set(bearer(admin)).send({ tag: "Watches" });
    expect(tagA.body.data.tags).toEqual(["watches"]);
    await api().post(`${A}/customers/${id}/tags`).set(bearer(admin)).send({ tag: "gifting" }).expect(200);
    await api().post(`${A}/customers/${id}/tags`).set(bearer(admin)).send({ tag: "watches" }).expect(200); // idempotent

    let d = await api().get(`${A}/customers/${id}`).set(bearer(admin));
    expect(d.body.data.notes).toHaveLength(1);
    expect(d.body.data.tags).toEqual(["gifting", "watches"]);

    await api().delete(`${A}/customers/${id}/notes/${note.body.data.id}`).set(bearer(admin)).expect(200);
    expect((await api().delete(`${A}/customers/${id}/notes/${note.body.data.id}`).set(bearer(admin))).status).toBe(404);
    const rm = await api().delete(`${A}/customers/${id}/tags/gifting`).set(bearer(admin));
    expect(rm.body.data.tags).toEqual(["watches"]);
    d = await api().get(`${A}/customers/${id}`).set(bearer(admin));
    expect(d.body.data.notes).toHaveLength(0);

    const audits = await prisma.auditEvent.findMany({ where: { entity: "customer", entityId: id } });
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["customer.tier_changed", "customer.marketing_changed", "customer.note_added", "customer.note_removed", "customer.tag_added", "customer.tag_removed"]),
    );
  });

  it("blocking signs the customer out: their token gets 403 on /store/me", async () => {
    const c = await registerCustomer();
    expect((await api().get(`${S}/me`).set(bearer(c.token))).status).toBe(200);
    const r = await api().patch(`${A}/customers/${c.customer.id}/status`).set(bearer(admin)).send({ status: "blocked", reason: "Chargeback fraud" });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("blocked");
    const me = await api().get(`${S}/me`).set(bearer(c.token));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe("ACCOUNT_BLOCKED");
    expect(await prisma.customerSession.count({ where: { customerId: c.customer.id, revokedAt: null } })).toBe(0);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "customer.status_changed", entityId: c.customer.id } });
    expect(audit?.summary).toContain("active → blocked");
    const blocked = await api().get(`${A}/customers`).query({ tab: "blocked" }).set(bearer(admin));
    expect(blocked.body.data.map((x: any) => x.id)).toContain(c.customer.id);
  });

  it("wallet adjust needs customers.wallet and can't go below zero", async () => {
    const id = big.customer.id;
    const credit = await api().post(`${A}/customers/${id}/wallet-adjust`).set(bearer(admin)).send({ amount: N(5_000), kind: "credit", note: "Goodwill credit" });
    expect(credit.status).toBe(200);
    expect(credit.body.data.walletBalance).toBe(N(5_000));
    const over = await api().post(`${A}/customers/${id}/wallet-adjust`).set(bearer(admin)).send({ amount: -N(6_000), note: "Too much" });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("INSUFFICIENT_WALLET_BALANCE");

    const support = (await createAdmin("support")).token;
    expect((await api().get(`${A}/customers`).set(bearer(support))).status).toBe(200);
    expect((await api().post(`${A}/customers/${id}/wallet-adjust`).set(bearer(support)).send({ amount: N(1_000), note: "nope" })).status).toBe(403);
    expect((await api().patch(`${A}/customers/${id}/tier`).set(bearer(support)).send({ tier: "Silver" })).status).toBe(403);

    const row = await api().get(`${A}/customers/${id}`).set(bearer(admin));
    expect(row.body.data.walletBalance).toBe(N(5_000));
  });

  it("delete = anonymise: refused while the wallet holds money; keeps orders", async () => {
    const id = big.customer.id;
    // an order to keep
    const [p] = await pickProducts(1);
    await api().post(`${S}/cart/items`).set(bearer(big.token)).send({ productId: p!.handle, size: p!.size, color: p!.color, qty: 1 }).expect(201);
    await api().patch(`${S}/checkout`).set(bearer(big.token)).send({ contact: { email: big.email, phone: "+2348012345678" }, address: lagos });
    const placed = await api().post(`${S}/checkout/place-order`).set(bearer(big.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(placed.status).toBe(201);
    const orderId = placed.body.data.order.id;
    const detail = await api().get(`${A}/customers/${id}`).set(bearer(admin));
    expect(detail.body.data.recentOrders[0]).toMatchObject({ id: orderId });

    const refused = await api().delete(`${A}/customers/${id}`).set(bearer(admin));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("wallet");
    await api().post(`${A}/customers/${id}/wallet-adjust`).set(bearer(admin)).send({ amount: -N(5_000), note: "Refunded to bank before closing" }).expect(200);

    const del = await api().delete(`${A}/customers/${id}`).set(bearer(admin));
    expect(del.status).toBe(200);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
    expect(c.email).not.toBe(big.email);
    expect(c.firstName).toBe("Deleted");
    expect(c.phone).toBeNull();
    expect(c.passwordHash).toBeNull();
    expect(c.deletedAt).not.toBeNull();
    expect(await prisma.address.count({ where: { customerId: id } })).toBe(0);
    expect(await prisma.order.count({ where: { id: orderId, customerId: id } })).toBe(1);

    expect((await api().get(`${A}/customers/${id}`).set(bearer(admin))).status).toBe(404);
    expect((await api().get(`${A}/customers`).query({ q: tag }).set(bearer(admin))).body.data.map((x: any) => x.id)).not.toContain(id);
    expect((await api().post(`${S}/auth/login`).send({ email: big.email, password: big.password })).status).toBe(401);
    expect((await api().get(`${S}/me`).set(bearer(big.token))).status).toBe(403);
    expect(await prisma.auditEvent.count({ where: { action: "customer.anonymised", entityId: id } })).toBe(1);
  });
});

describe("abandoned carts", () => {
  let products: Pick[];
  let shopper: Awaited<ReturnType<typeof registerCustomer>>;
  let shopperCartId: string;
  let guestToken: string;
  let guestCartId: string;
  const guestEmail = `${uniq("g")}@test.dev`;

  const ago = (ms: number) => new Date(Date.now() - ms);
  const cart = (id: string) => prisma.cart.findUniqueOrThrow({ where: { id } });
  const mailsTo = (to: string) => (mail.outbox ?? []).filter((m) => m.to === to && m.subject === "You left something behind");

  beforeAll(async () => {
    products = await pickProducts(2);
    shopper = await registerCustomer();
    const add = await api().post(`${S}/cart/items`).set(bearer(shopper.token)).send({ productId: products[0]!.handle, size: products[0]!.size, color: products[0]!.color, qty: 1 });
    shopperCartId = add.body.data.id;

    const g = await api().post(`${S}/cart/items`).send({ productId: products[1]!.handle, size: products[1]!.size, color: products[1]!.color, qty: 2 });
    guestToken = g.body.data.guestToken;
    guestCartId = g.body.data.id;
    // the guest typed an email on the checkout contact step
    const ck = await api().patch(`${S}/checkout`).set("X-Cart-Token", guestToken).send({ contact: { email: guestEmail, phone: "+2348012345678" } });
    expect(ck.status).toBe(200);
  });

  it("scan marks idle bags with an email as abandoned (not the anonymous guest)", async () => {
    const anon = await api().post(`${S}/cart/items`).send({ productId: products[1]!.handle, size: products[1]!.size, color: products[1]!.color, qty: 1 });
    const anonId = anon.body.data.id;
    await prisma.cart.updateMany({ where: { id: { in: [shopperCartId, guestCartId, anonId] } }, data: { lastActivityAt: ago(2 * 60 * MIN) } });

    const r = await abandonedCartsService.scan();
    expect(r.abandoned).toBeGreaterThanOrEqual(2);
    expect((await cart(shopperCartId)).status).toBe("abandoned");
    expect((await cart(guestCartId)).status).toBe("abandoned");
    expect((await cart(guestCartId)).abandonedAt).not.toBeNull();
    expect((await cart(anonId)).status).toBe("active");

    // the bag is still there for the returning customer and for the guest link
    const bag = await api().get(`${S}/cart`).set(bearer(shopper.token));
    expect(bag.body.data.count).toBe(1);
    expect((await api().get(`${S}/cart`).set("X-Cart-Token", guestToken)).body.data.count).toBe(2);
  });

  it("sends reminder 1 and 2 when due (once each), with the right recovery link", async () => {
    // not due yet (rule 1 = 60 min after abandon)
    await abandonedCartsService.scan();
    expect(mailsTo(shopper.email)).toHaveLength(0);

    await prisma.cart.updateMany({ where: { id: { in: [shopperCartId, guestCartId] } }, data: { abandonedAt: ago(61 * MIN) } });
    const r1 = await abandonedCartsService.scan();
    expect(r1.reminded).toBe(2);
    await abandonedCartsService.scan(); // no duplicate
    expect(mailsTo(shopper.email)).toHaveLength(1);
    expect(mailsTo(guestEmail)).toHaveLength(1);
    expect(mailsTo(shopper.email)[0]!.html).toContain(`href="${env.WEB_URL}/cart"`);
    expect(mailsTo(guestEmail)[0]!.html).toContain(`${env.WEB_URL}/cart?recover=${guestToken}`);
    expect((await cart(shopperCartId)).reminderStage).toBe(1);

    await prisma.cart.updateMany({ where: { id: { in: [shopperCartId, guestCartId] } }, data: { abandonedAt: ago(25 * 60 * MIN) } });
    await abandonedCartsService.scan();
    expect(mailsTo(guestEmail)).toHaveLength(2);
    expect((await cart(guestCartId)).reminderStage).toBe(2);

    const list = await api().get(`${A}/carts/abandoned`).set(bearer(admin));
    expect(list.status).toBe(200);
    const row = list.body.data.find((c: any) => c.id === guestCartId);
    expect(row).toMatchObject({ customer: "Guest", email: guestEmail, stage: "Reminder 2 sent", itemsCount: 2, total: products[1]!.price * 2, channel: "Desktop web" });
    expect(row.lastActivityAt).toBeTruthy();
    expect(list.body.meta.tabs.reminder_2).toBe(2);
    expect(list.body.meta.kpis.activeAbandoned).toBe(2);
    expect(list.body.meta.kpis.valueAtRisk).toBe(products[0]!.price + products[1]!.price * 2);
    const tab = await api().get(`${A}/carts/abandoned`).query({ stage: "reminder_2", q: guestEmail }).set(bearer(admin));
    expect(tab.body.data.map((c: any) => c.id)).toEqual([guestCartId]);
  });

  it("goes lost 7 days after the last reminder; admin can't remind lost carts", async () => {
    await prisma.$executeRaw`UPDATE \`Cart\` SET updatedAt = ${ago(8 * DAY)} WHERE id = ${guestCartId}`;
    const r = await abandonedCartsService.scan();
    expect(r.lost).toBe(1);
    expect((await cart(guestCartId)).status).toBe("lost");
    const remind = await api().post(`${A}/carts/${guestCartId}/remind`).set(bearer(admin)).send({ channel: "email" });
    expect(remind.status).toBe(409);
    expect(remind.body.error.message).toContain("lost");
  });

  it("returning customer edits the bag (back to active) and orders → recovered", async () => {
    await api().post(`${S}/cart/items`).set(bearer(shopper.token)).send({ productId: products[1]!.handle, size: products[1]!.size, color: products[1]!.color, qty: 1 }).expect(201);
    let c = await cart(shopperCartId);
    expect(c.status).toBe("active");
    expect(c.abandonedAt).not.toBeNull();
    expect(c.reminderStage).toBe(0);

    await api().patch(`${S}/checkout`).set(bearer(shopper.token)).send({ contact: { email: shopper.email, phone: "+2348012345678" }, address: lagos });
    const placed = await api().post(`${S}/checkout/place-order`).set(bearer(shopper.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(placed.status).toBe(201);
    const pay = await api().post(`${W}/mock/checkout/${placed.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
    expect(pay.status).toBe(200);
    await settle();
    c = await cart(shopperCartId);
    expect(c.status).toBe("recovered");
    expect(c.recoveredAt).not.toBeNull();

    const remind = await api().post(`${A}/carts/${shopperCartId}/remind`).set(bearer(admin)).send({});
    expect(remind.status).toBe(409);
    expect(remind.body.error.message).toContain("recovered");

    const list = await api().get(`${A}/carts/abandoned`).query({ stage: "recovered" }).set(bearer(admin));
    expect(list.body.data[0]).toMatchObject({ id: shopperCartId, stage: "Recovered" });
    expect(list.body.meta.kpis.recovered30d).toBe(1);
    expect(list.body.meta.kpis.recoveredValue30d).toBe(products[0]!.price + products[1]!.price);
    expect(list.body.meta.kpis.recoveryRate).toBe(50);
  });

  it("manual reminders: email / push checks, bulk, and errors", async () => {
    const c = await registerCustomer();
    const add = await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: products[0]!.handle, size: products[0]!.size, color: products[0]!.color, qty: 1 });
    const id = add.body.data.id;

    const active = await api().post(`${A}/carts/${id}/remind`).set(bearer(admin)).send({ channel: "email" });
    expect(active.status).toBe(409);

    await prisma.cart.update({ where: { id }, data: { lastActivityAt: ago(3 * 60 * MIN) } });
    await abandonedCartsService.scan();
    const ok = await api().post(`${A}/carts/${id}/remind`).set(bearer(admin)).send({ channel: "email" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.stage).toBe("Reminder 1 sent");
    expect(mailsTo(c.email)).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { action: "cart.reminder_sent", entityId: id } })).toBe(1);

    // a guest bag without email (only an admin could see one) and push to a guest
    const g = await prisma.cart.create({ data: { guestToken: uniq("tok"), status: "abandoned", abandonedAt: new Date(), items: { create: { productId: products[0]!.productId, qty: 1, unitPrice: products[0]!.price, size: products[0]!.size, color: products[0]!.color } } } });
    const noEmail = await api().post(`${A}/carts/${g.id}/remind`).set(bearer(admin)).send({ channel: "email" });
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.message).toBe("No email captured for this cart.");
    expect((await api().post(`${A}/carts/${g.id}/remind`).set(bearer(admin)).send({ channel: "push" })).status).toBe(400);
    expect((await api().post(`${A}/carts/nope/remind`).set(bearer(admin)).send({})).status).toBe(404);

    const bulk = await api().post(`${A}/carts/remind-bulk`).set(bearer(admin)).send({ ids: [id, g.id, shopperCartId] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.sent).toBe(1);
    expect(bulk.body.data.skipped.map((s: any) => s.id).sort()).toEqual([g.id, shopperCartId].sort());
    expect((await cart(id)).reminderStage).toBe(2);
    const none = await api().post(`${A}/carts/remind-bulk`).set(bearer(admin)).send({ ids: [g.id] });
    expect(none.status).toBe(400);
  });

  it("recovery rules: read, save, validate; marketing.manage only", async () => {
    const r = await api().get(`${A}/carts/recovery-rules`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ abandonMinutes: 60, lostAfterDays: 7 });
    expect(r.body.data.rules.map((x: any) => [x.stage, x.delayMinutes])).toEqual([[1, 60], [2, 1440]]);

    const save = await api().put(`${A}/carts/recovery-rules`).set(bearer(admin)).send({
      rules: [
        { stage: 1, delayMinutes: 30, channel: "email", enabled: true },
        { stage: 2, delayMinutes: 360, channel: "push", enabled: true },
        { stage: 3, delayMinutes: 1440, channel: "email", enabled: false },
      ],
    });
    expect(save.status).toBe(200);
    expect(save.body.data.rules).toHaveLength(3);
    expect(save.body.data.rules[1]).toMatchObject({ stage: 2, channel: "push", templateCode: "cart.reminder" });

    const bad = await api().put(`${A}/carts/recovery-rules`).set(bearer(admin)).send({ rules: [{ stage: 1, delayMinutes: 600 }, { stage: 2, delayMinutes: 60 }] });
    expect(bad.status).toBe(400);
    const dup = await api().put(`${A}/carts/recovery-rules`).set(bearer(admin)).send({ rules: [{ stage: 1, delayMinutes: 60 }, { stage: 1, delayMinutes: 120 }] });
    expect(dup.status).toBe(400);

    await api().put(`${A}/carts/recovery-rules`).set(bearer(admin)).send({ rules: [{ stage: 1, delayMinutes: 60 }, { stage: 2, delayMinutes: 1440 }] }).expect(200);
    expect(await prisma.recoveryRule.count()).toBe(2);
    expect(await prisma.auditEvent.count({ where: { action: "cart.recovery_rules_saved" } })).toBe(2);

    const support = (await createAdmin("support")).token;
    expect((await api().get(`${A}/carts/abandoned`).set(bearer(support))).status).toBe(403);
  });
});
