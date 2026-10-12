import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connectClient, type Socket } from "socket.io-client";
import { api, app, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { attachRealtime } from "@/core/realtime/realtime.server";
import { realtime } from "@/core/realtime/realtime";
import { mail } from "@/providers/mail/mail";
import { push } from "@/providers/push/push";
import { seedCatalog } from "../../prisma/seed/catalog";
import { notify } from "@/modules/support/notifications/notifications.service";
import { payoutsService } from "@/modules/payments/payouts/payouts.service";
import { clubService } from "@/modules/loyalty/club/club.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const DAY = 86_400_000;

const pushOutbox = () => (push as unknown as { outbox: { tokens: string[]; title: string; body: string; data?: Record<string, string> }[] }).outbox;
const lagos = { fullName: "Ada Obi", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

let server: http.Server;
let url: string;
const sockets: Socket[] = [];

type Customer = Awaited<ReturnType<typeof registerCustomer>>;
type Admin = Awaited<ReturnType<typeof createAdmin>>;
let alice: Customer;
let bob: Customer;
let superAdmin: Admin;
let agent: Admin;
let finance: Admin;
let catalogMgr: Admin;

/** resolves on connect, rejects with the connect_error */
function connect(opts: { token?: string; audience?: string; cookie?: string } = {}) {
  const s = connectClient(url, {
    transports: ["websocket"], reconnection: false, forceNew: true,
    auth: { ...(opts.token ? { token: opts.token } : {}), ...(opts.audience ? { audience: opts.audience } : {}) },
    extraHeaders: opts.cookie ? { cookie: opts.cookie } : undefined,
  });
  sockets.push(s);
  return new Promise<Socket>((resolve, reject) => {
    s.once("connect", () => resolve(s));
    s.once("connect_error", (err) => reject(err));
  });
}

/** next `event` matching `pred` (rejects after `ms`) */
function next(s: Socket, event: string, pred: (p: any) => boolean = () => true, ms = 4000) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(event, on);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    const on = (p: unknown) => {
      if (!pred(p)) return;
      clearTimeout(timer);
      s.off(event, on);
      resolve(p);
    };
    s.on(event, on);
  });
}

/** collects every `event` until stopped */
function collect<T = any>(s: Socket, event: string) {
  const got: T[] = [];
  const on = (p: T) => got.push(p);
  s.on(event, on);
  return { got, stop: () => s.off(event, on) };
}

const join = (s: Socket, room: string) => s.timeout(4000).emitWithAck("join", room) as Promise<{ ok: boolean; room?: string; error?: string }>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submitRequest(token: string, itemName = "Air Jordan 1 Retro High OG") {
  const r = await api().post(`${S}/concierge/requests`).set(bearer(token))
    .field("itemName", itemName).field("category", "Footwear").field("brand", "Jordan").field("size", "UK 9").field("budget", String(N(300_000)));
  expect(r.status).toBe(201);
  return r.body.data as { id: string; number: string };
}

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

/** places + pays a delivery order */
async function buy(c: Customer) {
  const p = await pickProduct();
  expect((await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 })).status).toBe(201);
  expect((await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos })).status).toBe(200);
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  const pay = await api().post(`${W}/mock/checkout/${r.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(pay.status).toBe(200);
  await settle();
  return prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  [superAdmin, agent, finance, catalogMgr] = [await createAdmin("super_admin"), await createAdmin("concierge_agent"), await createAdmin("finance"), await createAdmin("catalog_manager")];
  alice = await registerCustomer({ name: "Alice Ade" });
  bob = await registerCustomer({ name: "Bob Bello" });
  server = http.createServer(app);
  attachRealtime(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  await realtime.close();
});

describe("handshake", () => {
  it("rejects a missing, bad or revoked token", async () => {
    await expect(connect()).rejects.toMatchObject({ message: "UNAUTHENTICATED" });
    await expect(connect({ token: "garbage" })).rejects.toMatchObject({ message: "TOKEN_INVALID" });
    const c = await registerCustomer();
    await prisma.customerSession.updateMany({ where: { customerId: c.customer.id }, data: { revokedAt: new Date() } });
    await expect(connect({ token: c.token })).rejects.toMatchObject({ message: "TOKEN_INVALID" });
    // an admin token can't pose as a customer
    await expect(connect({ token: superAdmin.token, audience: "customer" })).rejects.toMatchObject({ message: "TOKEN_INVALID" });
  });

  it("accepts the auth token or the session cookie", async () => {
    const byCookie = await connect({ cookie: `asl_at=${encodeURIComponent(alice.token)}` });
    expect(byCookie.connected).toBe(true);
    // personal rooms only for yourself
    expect(await join(byCookie, `customer:${alice.customer.id}`)).toMatchObject({ ok: true });
    expect(await join(byCookie, `customer:${bob.customer.id}`)).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await join(byCookie, "admin:activity")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    const adminByCookie = await connect({ cookie: `asl_admin_at=${superAdmin.token}` });
    expect(await join(adminByCookie, "admin:activity")).toMatchObject({ ok: true, room: "admin:activity" });
    byCookie.close();
    adminByCookie.close();
  });
});

describe("customer socket", () => {
  let s: Socket;
  let req: { id: string; number: string };

  beforeAll(async () => {
    s = await connect({ token: alice.token });
  });

  it("receives its own inbox notifications, not other customers'", async () => {
    const mine = next(s, "notification.new", (n: { title: string }) => n.title === "Realtime hello");
    const others = collect(s, "notification.new");
    await notify(bob.customer.id, { category: "Account", title: "Not for Alice", message: "Bob only" });
    await notify(alice.customer.id, { category: "Account", title: "Realtime hello", message: "Hi Alice", ctaLink: "/account" });
    const n = await mine;
    expect(n).toMatchObject({ category: "Account", message: "Hi Alice", unread: true, ctaLink: "/account" });
    expect(typeof n.id).toBe("string");
    await wait(100);
    others.stop();
    expect(others.got.some((x: { title: string }) => x.title === "Not for Alice")).toBe(false);
  });

  it("joins its own concierge request room (by number) but not someone else's", async () => {
    req = await submitRequest(alice.token);
    const ok = await join(s, `concierge:request:${req.number}`);
    expect(ok).toEqual({ ok: true, room: `concierge:request:${req.id}` });

    const bobs = await submitRequest(bob.token, "Birkin 25");
    expect(await join(s, `concierge:request:${bobs.id}`)).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect(await join(s, `concierge:request:${bobs.number}`)).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect(await join(s, "concierge:request:nope")).toMatchObject({ ok: false, error: "NOT_FOUND" });
    // Bob's agent messages never reach Alice
    const leak = collect(s, "concierge.message");
    expect((await api().post(`${A}/concierge/threads/${bobs.id}/messages`).set(bearer(agent.token)).field("text", "For Bob only")).status).toBe(201);
    await wait(150);
    leak.stop();
    expect(leak.got).toHaveLength(0);
  });

  it("gets the agent's chat message live; the agent gets the customer's", async () => {
    const adminSocket = await connect({ token: agent.token });
    expect(await join(adminSocket, `concierge:request:${req.id}`)).toMatchObject({ ok: true });

    const got = next(s, "concierge.message", (p: { requestId: string; message: { sender: string } }) => p.requestId === req.id && p.message.sender === "agent");
    expect((await api().post(`${A}/concierge/threads/${req.id}/messages`).set(bearer(agent.token)).field("text", "Found a pair in UK 9")).status).toBe(201);
    const m = await got;
    expect(m).toMatchObject({ number: req.number, message: { sender: "agent", text: "Found a pair in UK 9", authorName: agent.admin.name } });

    const toAgent = next(adminSocket, "concierge.message", (p: { message: { sender: string } }) => p.message.sender === "customer");
    expect((await api().post(`${S}/concierge/requests/${req.id}/messages`).set(bearer(alice.token)).field("text", "Great, what price?")).status).toBe(201);
    expect((await toAgent).message.text).toBe("Great, what price?");

    // typing: relayed to the others in the room, throttled per socket
    const typing = collect(adminSocket, "concierge.typing");
    s.emit("concierge:typing", { requestId: req.id, typing: true });
    s.emit("concierge:typing", { requestId: req.id, typing: true }); // dropped (rate limit)
    s.emit("concierge:typing", { requestId: req.id, typing: false });
    await wait(200);
    typing.stop();
    expect(typing.got).toEqual([
      { requestId: req.id, from: "customer", name: "Alice Ade", typing: true },
      { requestId: req.id, from: "customer", name: "Alice Ade", typing: false },
    ]);
    // not echoed back + not accepted for rooms the socket didn't join
    const bobSocket = await connect({ token: bob.token });
    const bobTyping = collect(s, "concierge.typing");
    bobSocket.emit("concierge:typing", { requestId: req.id, typing: true });
    await wait(150);
    bobTyping.stop();
    expect(bobTyping.got).toHaveLength(0);
    adminSocket.close();
    bobSocket.close();
  });

  it("support can't join a concierge room without concierge.view (catalog manager)", async () => {
    const cm = await connect({ token: catalogMgr.token });
    expect(await join(cm, `concierge:request:${req.id}`)).toMatchObject({ ok: false, error: "FORBIDDEN" });
    cm.close();
  });

  it("ticket replies: public ones reach the customer, internal notes only staff", async () => {
    const t = await api().post(`${S}/support/tickets`).set(bearer(alice.token)).field("topic", "Where is my order?").field("message", "It is late, please check");
    expect(t.status).toBe(201);
    const ticketId = t.body.data.id as string;
    expect(await join(s, `ticket:${ticketId}`)).toMatchObject({ ok: true });
    const bobSocket = await connect({ token: bob.token });
    expect(await join(bobSocket, `ticket:${ticketId}`)).toMatchObject({ ok: false, error: "NOT_FOUND" });
    bobSocket.close();

    const staff = await connect({ token: superAdmin.token });
    expect(await join(staff, `ticket:${ticketId}`)).toMatchObject({ ok: true });
    const custGot = collect(s, "ticket.message");
    const staffGot = collect(staff, "ticket.message");
    expect((await api().post(`${A}/tickets/${ticketId}/reply`).set(bearer(superAdmin.token)).field("body", "Internal: check courier").field("internal", "true")).status).toBeLessThan(300);
    expect((await api().post(`${A}/tickets/${ticketId}/reply`).set(bearer(superAdmin.token)).field("body", "It ships today")).status).toBeLessThan(300);
    await wait(200);
    custGot.stop();
    staffGot.stop();
    expect(custGot.got.map((x: { message: { body: string } }) => x.message.body)).toEqual(["It ships today"]);
    expect(staffGot.got.map((x: { message: { body: string; internal: boolean } }) => [x.message.body, x.message.internal])).toEqual([
      ["Internal: check courier", true],
      ["It ships today", false],
    ]);
    staff.close();
  });
});

describe("admin socket", () => {
  it("bell rows + activity filtered by permission", async () => {
    const fin = await connect({ token: finance.token });
    const cm = await connect({ token: catalogMgr.token });
    expect(await join(fin, "admin:activity")).toMatchObject({ ok: true });
    expect(await join(cm, "admin:activity")).toMatchObject({ ok: true });
    const finActivity = collect(fin, "activity.new");
    const cmActivity = collect(cm, "activity.new");

    // a product change: catalog.view sees it, finance doesn't
    const brand = await prisma.brand.findFirstOrThrow();
    const cat = await prisma.category.findFirstOrThrow();
    const created = await api().post(`${A}/products`).set(bearer(superAdmin.token)).send({
      name: "Realtime Runner Tee", brandId: brand.id, categoryId: cat.id, price: N(120_000), sizes: ["S", "M"], colors: [{ name: "Black", hex: "#000" }],
    });
    expect(created.status).toBe(201);
    const productId = created.body.data.productId as string;
    expect((await api().patch(`${A}/products/${productId}/status`).set(bearer(superAdmin.token)).send({ status: "active" })).status).toBe(200);
    await settle();

    // a settlement: payout.pending → finance bell + activity for finance only
    const order = await buy(alice);
    await prisma.payment.updateMany({ where: { orderId: order.id }, data: { paidAt: new Date(Date.now() - 2 * DAY) } });
    const bell = next(fin, "admin.notification", (n: { ruleId: string }) => n.ruleId === "finance_payout");
    const synced = await payoutsService.sync();
    expect(synced.created).toBeGreaterThanOrEqual(1);
    await settle();
    expect(await bell).toMatchObject({ read: false, scope: "me", priority: "normal", link: `/payouts?id=${synced.payouts[0].id}` });
    await wait(150);
    finActivity.stop();
    cmActivity.stop();

    expect(finActivity.got.some((a: { type: string }) => a.type === "payout.pending")).toBe(true);
    expect(finActivity.got.some((a: { type: string }) => a.type === "catalog.updated")).toBe(false);
    expect(cmActivity.got.filter((a: { type: string }) => a.type === "catalog.updated").map((a: { title: string }) => a.title)).toEqual([
      "Product added · Realtime Runner Tee",
      "Product published · Realtime Runner Tee",
    ]);
    expect(cmActivity.got.some((a: { type: string }) => a.type.startsWith("payout."))).toBe(false);
    fin.close();
    cm.close();
  });

  it("role-wide bell rows (concierge) reach every admin of that role", async () => {
    const ag = await connect({ token: agent.token });
    const bell = next(ag, "admin.notification", (n: { ruleId: string }) => n.ruleId === "concierge_request");
    await submitRequest(bob.token, "Kelly 25");
    await settle();
    expect(await bell).toMatchObject({ scope: "role", id: null, priority: "high" });
    ag.close();
  });

  it("a role change alerts super admins (system_role, absolute admin link) and reconnects the member's sockets", async () => {
    const member = await createAdmin("analyst");
    const ms = await connect({ token: member.token });
    const sa = await connect({ token: superAdmin.token });
    const dropped = new Promise<string>((resolve) => ms.once("disconnect", (reason) => resolve(reason)));
    const bell = next(sa, "admin.notification", (n: { ruleId: string }) => n.ruleId === "system_role");
    const before = mail.outbox!.length;
    const r = await api().patch(`${A}/team/members/${member.admin.id}`).set(bearer(superAdmin.token)).send({ role: "marketing" });
    expect(r.status).toBe(200);
    await settle();
    expect((await bell).title).toContain(member.admin.name);
    expect(await dropped).toBe("io server disconnect");
    const alert = mail.outbox!.slice(before).find((m) => m.to === superAdmin.email && m.subject.includes("Role changed"));
    expect(alert?.html).toContain("http://localhost:3001/team");
    sa.close();
  });
});

describe("push preferences", () => {
  it("shipping topic off → no push for 'shipped', but the order-shipped e-mail still goes out", async () => {
    const c = await registerCustomer({ name: "Pref Tester" });
    const token = `ExponentPushToken[${uniq("tok")}]`;
    expect((await api().post(`${S}/me/push-tokens`).set(bearer(c.token)).send({ token, platform: "expo" })).status).toBeLessThan(300);
    const pushesTo = () => pushOutbox().filter((m) => m.tokens.includes(token));

    const order = await buy(c);
    // orders topic on → confirmation push sent
    expect(pushesTo().some((m) => m.data?.orderNumber === order.number)).toBe(true);
    const confirmations = pushesTo().length;

    expect((await api().put(`${S}/me/notification-preferences`).set(bearer(c.token)).send({ topics: { shipping: false } })).status).toBe(200);
    const s = await connect({ token: c.token });
    const live = next(s, "order.updated", (p: { orderId: string; event: string }) => p.orderId === order.id && p.event === "shipped");
    const before = mail.outbox!.length;
    const f = await api().post(`${A}/orders/${order.id}/fulfil`).set(bearer(superAdmin.token)).send({ carrier: "In-house", service: "Same day", trackingNumber: "TRK-RT-1" });
    expect(f.status).toBe(201);
    expect((await api().post(`${A}/shipments/${f.body.data.id}/advance`).set(bearer(superAdmin.token)).send({ status: "picked_up", location: "Lagos Hub" })).status).toBe(200);
    await settle();

    expect(await live).toMatchObject({ number: order.number, status: "shipped", statusLabel: "Shipped" });
    expect(pushesTo()).toHaveLength(confirmations);
    const shippedMail = mail.outbox!.slice(before).find((m) => m.to === c.email && m.subject.includes(`${order.number} is on its way`));
    expect(shippedMail?.text).toContain("TRK-RT-1");
    // the inbox row is still written
    expect(await prisma.notification.count({ where: { customerId: c.customer.id, title: "Order Shipped" } })).toBe(1);
    s.close();
  });

  it("concierge agent messages push only while the concierge topic is on", async () => {
    const c = await registerCustomer({ name: "Chat Pref" });
    const token = `ExponentPushToken[${uniq("tok")}]`;
    await api().post(`${S}/me/push-tokens`).set(bearer(c.token)).send({ token, platform: "expo" });
    const r = await submitRequest(c.token, "Dior B22");
    const count = () => pushOutbox().filter((m) => m.tokens.includes(token) && m.data?.requestId === r.id).length;
    await api().post(`${A}/concierge/threads/${r.id}/messages`).set(bearer(agent.token)).field("text", "On it");
    await settle();
    const first = count();
    expect(first).toBeGreaterThanOrEqual(1);
    await api().put(`${S}/me/notification-preferences`).set(bearer(c.token)).send({ topics: { concierge: false } });
    await api().post(`${A}/concierge/threads/${r.id}/messages`).set(bearer(agent.token)).field("text", "Still on it");
    await settle();
    expect(count()).toBe(first);
  });
});

describe("missing events", () => {
  it("payout.pending writes an activity row", async () => {
    const rows = await prisma.activityEntry.findMany({ where: { type: "payout.pending" } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].title).toMatch(/^Payout PO-\d+ scheduled$/);
  });

  it("catalog.updated on create / update / status change", async () => {
    const titles = (await prisma.activityEntry.findMany({ where: { type: "catalog.updated" }, orderBy: { createdAt: "asc" } })).map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(["Product added · Realtime Runner Tee", "Product published · Realtime Runner Tee"]));
    const p = await prisma.product.findFirstOrThrow({ where: { name: "Realtime Runner Tee" } });
    expect((await api().patch(`${A}/products/${p.id}`).set(bearer(superAdmin.token)).send({ description: "Heavyweight" })).status).toBe(200);
    expect((await api().patch(`${A}/products/${p.id}`).set(bearer(superAdmin.token)).send({ description: "Heavier" })).status).toBe(200);
    await settle();
    // repeated saves collapse into one row
    expect(await prisma.activityEntry.count({ where: { type: "catalog.updated", title: "Product updated · Realtime Runner Tee" } })).toBe(1);
  });

  it("club tier upgrade → inbox row, activity, VIP staff alert at Signature", async () => {
    const c = await registerCustomer({ name: "Vera Vip" });
    const s = await connect({ token: c.token });
    const inbox = next(s, "notification.new", (n: { category: string }) => n.category === "ASL Club");
    const top = await prisma.clubTier.findFirstOrThrow({ where: { id: "Signature" } });
    await prisma.customerStats.upsert({ where: { customerId: c.customer.id }, create: { customerId: c.customer.id, spend12m: top.minSpend }, update: { spend12m: top.minSpend } });
    expect(await clubService.upgradeIfDue(c.customer.id)).toBe("Signature");
    await settle();
    expect(await inbox).toMatchObject({ title: "Welcome to Signature", ctaLink: "/account/benefits" });
    expect(await prisma.notification.count({ where: { customerId: c.customer.id, category: "ASLClub" } })).toBe(1);
    expect(await prisma.activityEntry.count({ where: { type: "customer.tier_upgraded", link: `/customers?id=${c.customer.id}` } })).toBe(1);
    expect(await prisma.activityEntry.count({ where: { type: "customer.vip", link: `/customers?id=${c.customer.id}` } })).toBe(1);
    expect(await prisma.adminNotification.count({ where: { ruleId: "customer_vip", link: `/customers?id=${c.customer.id}` } })).toBeGreaterThanOrEqual(1);
    s.close();

    // marked VIP by staff → alert too (deduped per customer per day)
    const d = await registerCustomer({ name: "Dee Vip" });
    expect((await api().patch(`${A}/customers/${d.customer.id}/status`).set(bearer(superAdmin.token)).send({ status: "vip" })).status).toBe(200);
    await settle();
    expect(await prisma.adminNotification.count({ where: { ruleId: "customer_vip", link: `/customers?id=${d.customer.id}` } })).toBeGreaterThanOrEqual(1);
    // an admin-set upgrade below Signature writes the inbox row, no VIP alert
    const e = await registerCustomer({ name: "Gil Gold" });
    expect((await api().patch(`${A}/customers/${e.customer.id}/tier`).set(bearer(superAdmin.token)).send({ tier: "Gold" })).status).toBe(200);
    await settle();
    expect(await prisma.notification.count({ where: { customerId: e.customer.id, title: "Welcome to Gold" } })).toBe(1);
    expect(await prisma.adminNotification.count({ where: { ruleId: "customer_vip", link: `/customers?id=${e.customer.id}` } })).toBe(0);
  });

  it("the five admin-listed rules are seeded", async () => {
    const rules = await prisma.notificationRule.findMany({ where: { id: { in: ["order_risk", "customer_vip", "finance_payout", "system_role", "system_backup"] } } });
    expect(rules.map((r) => r.id).sort()).toEqual(["customer_vip", "finance_payout", "order_risk", "system_backup", "system_role"]);
    const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
    expect(byId.order_risk).toMatchObject({ category: "orders", priority: "critical", enabled: true, recipients: ["ops_manager", "finance"] });
    expect(byId.system_backup).toMatchObject({ category: "system", priority: "low" });
    const overview = await api().get(`${A}/notification-settings`).set(bearer(superAdmin.token));
    expect(overview.status).toBe(200);
    expect(overview.body.data.rules).toHaveLength(17);
  });
});
