import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { push } from "@/providers/push/push";
import { seedCatalog } from "../../prisma/seed/catalog";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { ticketsService } from "@/modules/support/tickets/tickets.service";
import { notify } from "@/modules/support/notifications/notifications.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const pushOutbox = () => (push as unknown as { outbox: { tokens: string[]; title: string; body: string }[] }).outbox;

let superAdmin: Awaited<ReturnType<typeof createAdmin>>;
let support: Awaited<ReturnType<typeof createAdmin>>;
let marketing: Awaited<ReturnType<typeof createAdmin>>;
let alice: Awaited<ReturnType<typeof registerCustomer>>;
let png: Buffer;

const lagos = { fullName: "Alice Ade", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

/** bag → checkout → place → pay (mock) for one in-stock product */
async function buyAndPay(token: string, email: string) {
  const p = await prisma.product.findFirstOrThrow({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(140_000) } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= 2)!;
  const add = await api().post(`${S}/cart/items`).set(bearer(token)).send({ productId: p.handle, size: v.size, color: v.color, qty: 1 });
  expect(add.status).toBe(201);
  const ck = await api().patch(`${S}/checkout`).set(bearer(token)).send({ contact: { email, phone: "+2348012345678", subscribe: false }, delivery: "ship", address: lagos });
  expect(ck.status).toBe(200);
  const placed = await api().post(`${S}/checkout/place-order`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(placed.status).toBe(201);
  const paid = await api().post(`${W}/mock/checkout/${placed.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(paid.status).toBe(200);
  await settle();
  return placed.body.data.order as { id: string; number: string; total: number };
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  superAdmin = await createAdmin("super_admin");
  support = await createAdmin("support");
  marketing = await createAdmin("marketing");
  alice = await registerCustomer({ name: "Alice Ade" });
  png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#cc5000" } }).png().toBuffer();
  // staff e-mails are held back during quiet hours: keep the run independent of the clock
  await settingsService.update("staffAlerts", { quietHours: { ...(await settingsService.get("staffAlerts")).quietHours, enabled: false } }, "test");
}, 240_000);

describe("guest contact form", () => {
  it("creates a ticket, e-mails the guest and alerts the support team", async () => {
    mail.outbox!.length = 0;
    const bad = await api().post(`${S}/support/contact`).send({ name: "G", email: "nope", subject: "", message: "hi" });
    expect(bad.status).toBe(400);
    const r = await api().post(`${S}/support/contact`).send({ name: "Gina Guest", email: "Gina@Example.com", subject: "Order Issue", message: "Where is my parcel? It has been a week." });
    expect(r.status).toBe(201);
    expect(r.body.data.reference).toBe("#5201");
    await settle();
    const t = await prisma.ticket.findUniqueOrThrow({ where: { number: "#5201" }, include: { messages: true } });
    expect(t.customerId).toBeNull();
    expect(t.customerEmail).toBe("gina@example.com");
    expect(t.category).toBe("order");
    expect(t.channel).toBe("email");
    expect(t.slaDueAt!.getTime() - t.createdAt.getTime()).toBe(8 * 3_600_000); // normal priority SLA
    expect(t.messages).toHaveLength(1);
    expect(mail.outbox!.some((m) => m.to === "gina@example.com" && m.subject.includes("#5201"))).toBe(true);
    // rule customer_ticket → one bell row per support admin
    expect(await prisma.adminNotification.count({ where: { ruleId: "customer_ticket", adminId: support.admin.id } })).toBe(1);
    expect(await prisma.adminNotification.count({ where: { ruleId: "customer_ticket", adminId: marketing.admin.id } })).toBe(0);
    // rule e-mail channel on → support admin e-mailed
    expect(mail.outbox!.some((m) => m.to === support.email && m.subject.includes("New ticket #5201"))).toBe(true);
  });
});

describe("customer ticket → agent reply → reopen", () => {
  let id = "";

  it("signed-in customer opens a ticket with a topic, message and photo", async () => {
    const r = await api().post(`${S}/support/tickets`).set(bearer(alice.token))
      .field("topic", "Return & Refund").field("message", "The jacket arrived with a torn sleeve.").field("category", "returns")
      .attach("attachments", png, { filename: "sleeve.png", contentType: "image/png" });
    expect(r.status).toBe(201);
    const d = r.body.data;
    id = d.id;
    expect(d.reference).toBe("#5202");
    expect(d.statusKey).toBe("open");
    expect(d.status).toBe("Open");
    expect(d.messages[0].attachments).toHaveLength(1);
    await settle();
    // inbox row "Request Received"
    const inbox = await api().get(`${S}/me/notifications?category=Account`).set(bearer(alice.token));
    expect(inbox.body.data.some((n: { title: string }) => n.title === "Request Received")).toBe(true);
    const unauth = await api().post(`${S}/support/tickets`).send({ topic: "Other", message: "Hello there team" });
    expect(unauth.status).toBe(401);
  });

  it("admin inbox lists it with tabs and KPIs", async () => {
    const r = await api().get(`${A}/tickets?tab=open`).set(bearer(support.token));
    expect(r.status).toBe(200);
    expect(r.body.meta.tabs.open).toBe(2);
    expect(r.body.meta.tabs.unassigned).toBe(2);
    expect(r.body.meta.kpis).toMatchObject({ open: 2, slaBreached: 0, avgFirstResponseMinutes: null });
    const row = r.body.data.find((t: { id: string }) => t.id === id);
    expect(row).toMatchObject({ number: "#5202", category: "returns", sla: "ok", customerEmail: alice.email });
    const q = await api().get(`${A}/tickets?q=torn`).set(bearer(support.token));
    expect(q.body.data.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it("internal notes stay internal; a public reply is the first response", async () => {
    const note = await api().post(`${A}/tickets/${id}/reply`).set(bearer(support.token)).send({ body: "Check the courier photos first.", internal: true });
    expect(note.status).toBe(200);
    expect(note.body.data.firstResponseAt).toBeNull();
    expect(note.body.data.status).toBe("open");

    mail.outbox!.length = 0;
    const reply = await api().post(`${A}/tickets/${id}/reply`).set(bearer(support.token)).send({ body: "So sorry! We'll collect it and send a new one." });
    expect(reply.status).toBe(200);
    expect(reply.body.data.firstResponseAt).not.toBeNull();
    expect(reply.body.data.status).toBe("pending");
    expect(reply.body.data.assigneeId).toBe(support.admin.id); // first responder picks it up
    expect(reply.body.data.sla).toBe("met");
    expect(reply.body.data.messages.filter((m: { internal: boolean }) => m.internal)).toHaveLength(1);
    await settle();
    expect(mail.outbox!.some((m) => m.to === alice.email && m.subject.includes("#5202"))).toBe(true);

    const mine = await api().get(`${S}/me/tickets/${id}`).set(bearer(alice.token));
    expect(mine.status).toBe(200);
    expect(mine.body.data.status).toBe("Awaiting You");
    expect(mine.body.data.messages.map((m: { body: string }) => m.body)).toEqual([
      "The jacket arrived with a torn sleeve.",
      "So sorry! We'll collect it and send a new one.",
    ]);
    expect(JSON.stringify(mine.body.data)).not.toContain("courier photos");
    // by number too
    expect((await api().get(`${S}/me/tickets/5202`).set(bearer(alice.token))).body.data.id).toBe(id);
    // someone else's ticket is invisible
    const bob = await registerCustomer();
    expect((await api().get(`${S}/me/tickets/${id}`).set(bearer(bob.token))).status).toBe(404);
    // inbox row for the reply
    const inbox = await api().get(`${S}/me/notifications`).set(bearer(alice.token));
    expect(inbox.body.data[0].title).toBe("Client Support replied");
    expect(inbox.body.data[0].ctaLink).toBe(`/account/tickets/${id}`);
  });

  it("customer answers → back to open; assignee gets a bell row", async () => {
    const r = await api().post(`${S}/me/tickets/${id}/messages`).set(bearer(alice.token)).field("body", "Thanks, Friday works.");
    expect(r.status).toBe(201);
    expect(r.body.data.statusKey).toBe("open");
    await settle();
    expect(await prisma.adminNotification.count({ where: { adminId: support.admin.id, title: { contains: "replied · #5202" } } })).toBe(1);
    const list = await api().get(`${S}/me/tickets?tab=open`).set(bearer(alice.token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].messageCount).toBe(3);
    expect(list.body.meta.tabs).toMatchObject({ all: 1, open: 1, closed: 0 });
  });

  it("status, priority, tags, assignment; customer reopens a resolved ticket", async () => {
    const pr = await api().patch(`${A}/tickets/${id}/priority`).set(bearer(support.token)).send({ priority: "urgent" });
    expect(pr.status).toBe(200);
    expect(pr.body.data.priority).toBe("urgent");
    const tag = await api().post(`${A}/tickets/${id}/tags`).set(bearer(support.token)).send({ tag: "Damaged" });
    expect(tag.body.data.tags).toEqual(["damaged"]);
    expect((await api().get(`${A}/tickets?tag=damaged`).set(bearer(support.token))).body.data).toHaveLength(1);
    const untag = await api().delete(`${A}/tickets/${id}/tags/damaged`).set(bearer(support.token));
    expect(untag.body.data.tags).toEqual([]);
    const badAssign = await api().post(`${A}/tickets/${id}/assign`).set(bearer(support.token)).send({ adminId: marketing.admin.id });
    expect(badAssign.status).toBe(400);
    const assign = await api().post(`${A}/tickets/${id}/assign`).set(bearer(superAdmin.token)).send({ adminId: support.admin.id });
    expect(assign.status).toBe(200);
    expect(assign.body.data.assignee).toBe(support.admin.name);

    const notYet = await api().post(`${S}/me/tickets/${id}/reopen`).set(bearer(alice.token));
    expect(notYet.status).toBe(409);
    const res = await api().patch(`${A}/tickets/${id}/status`).set(bearer(support.token)).send({ status: "resolved" });
    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.resolvedAt).not.toBeNull();
    const re = await api().post(`${S}/me/tickets/${id}/reopen`).set(bearer(alice.token));
    expect(re.status).toBe(200);
    expect(re.body.data.statusKey).toBe("open");
    expect(re.body.data.messages.at(-1).body).toContain("reopened");

    await api().patch(`${A}/tickets/${id}`).set(bearer(support.token)).send({ status: "closed" });
    const closed = await api().post(`${S}/me/tickets/${id}/messages`).set(bearer(alice.token)).send({ body: "One more thing" });
    expect(closed.status).toBe(409);
    expect(await prisma.auditEvent.count({ where: { entity: "ticket", entityId: id } })).toBeGreaterThanOrEqual(5);
  });
});

describe("SLA", () => {
  it("support.sla-check flags tickets past their first-response SLA once and alerts the team", async () => {
    const t = await prisma.ticket.findUniqueOrThrow({ where: { number: "#5201" } });
    await prisma.ticket.update({ where: { id: t.id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });
    const flagged = await ticketsService.slaCheck();
    expect(flagged.map((f) => f.number)).toEqual(["#5201"]);
    expect(await prisma.adminNotification.count({ where: { adminId: support.admin.id, title: { contains: "SLA breached · ticket #5201" } } })).toBe(1);
    expect(await ticketsService.slaCheck()).toEqual([]);
    const list = await api().get(`${A}/tickets?tab=breached`).set(bearer(support.token));
    expect(list.body.data.map((x: { number: string }) => x.number)).toEqual(["#5201"]);
    expect(list.body.data[0].sla).toBe("breached");
    expect(list.body.meta.kpis.slaBreached).toBe(1);
    expect(list.body.meta.kpis.avgFirstResponseMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe("permissions", () => {
  it("support can read and reply; marketing cannot", async () => {
    const t = await prisma.ticket.findUniqueOrThrow({ where: { number: "#5201" } });
    expect((await api().get(`${A}/tickets`).set(bearer(marketing.token))).status).toBe(403);
    expect((await api().post(`${A}/tickets/${t.id}/reply`).set(bearer(marketing.token)).send({ body: "hi" })).status).toBe(403);
    const ok = await api().post(`${A}/tickets/${t.id}/reply`).set(bearer(support.token)).send({ body: "On it — checking with the courier." });
    expect(ok.status).toBe(200);
    expect(ok.body.data.sla).toBe("missed");
    expect((await api().get(`${A}/notification-settings`).set(bearer(support.token))).status).toBe(403);
    expect((await api().get(`${A}/feedback`).set(bearer(marketing.token))).status).toBe(403);
  });
});

describe("feedback", () => {
  it("customer sends feedback; support triages it", async () => {
    const short = await api().post(`${S}/feedback`).set(bearer(alice.token)).send({ type: "idea", area: "Checkout", message: "meh" });
    expect(short.status).toBe(400);
    const r = await api().post(`${S}/feedback`).set(bearer(alice.token)).send({ type: "idea", area: "Checkout", message: "Please add Apple Pay at checkout.", email: "" });
    expect(r.status).toBe(201);
    const list = await api().get(`${A}/feedback?status=new`).set(bearer(support.token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].customer.email).toBe(alice.email);
    expect(list.body.meta.tabs).toMatchObject({ all: 1, new: 1 });
    expect(list.body.meta.kpis.idea).toBe(1);
    const p = await api().patch(`${A}/feedback/${r.body.data.id}/status`).set(bearer(support.token)).send({ status: "triaged" });
    expect(p.body.data.status).toBe("triaged");
  });
});

describe("paid order → customer inbox + staff bell", () => {
  it("order.paid writes the customer's inbox row and order_new bell rows", async () => {
    const before = await prisma.adminNotification.count({ where: { ruleId: "order_new" } });
    const o = await buyAndPay(alice.token, alice.email);
    const inbox = await api().get(`${S}/me/notifications?category=Orders`).set(bearer(alice.token));
    expect(inbox.status).toBe(200);
    const row = inbox.body.data.find((n: { title: string }) => n.title === "Order Confirmed");
    expect(row).toMatchObject({ category: "Orders", unread: true, ctaLink: `/account/orders/${o.number}`, icon: "Package" });
    expect(row.message).toContain(o.number);
    // order_new → super_admin (ops_manager has no member here); support / marketing not recipients
    expect(await prisma.adminNotification.count({ where: { ruleId: "order_new" } })).toBe(before + 1);
    const bell = await api().get(`${A}/notifications`).set(bearer(superAdmin.token));
    expect(bell.status).toBe(200);
    expect(bell.body.data[0].title).toBe(`New order ${o.number}`);
    expect(bell.body.meta.unread).toBeGreaterThanOrEqual(1);
    // default threshold ₦2M → no high-value alert
    expect(await prisma.adminNotification.count({ where: { ruleId: "order_high_value" } })).toBe(0);
  });

  it("orders above orders.highValueThreshold also fire order_high_value", async () => {
    await settingsService.update("orders", { highValueThreshold: N(1_000) }, "test");
    const o = await buyAndPay(alice.token, alice.email);
    const hv = await prisma.adminNotification.findMany({ where: { ruleId: "order_high_value" } });
    expect(hv.map((n) => n.adminId)).toEqual([superAdmin.admin.id]);
    expect(hv[0].title).toContain(o.number);
    expect(hv[0].priority).toBe("critical");
    await settingsService.update("orders", { highValueThreshold: N(2_000_000) }, "test");
  });

  it("customer inbox: unread count, read, read-all, delete", async () => {
    const count = await api().get(`${S}/me/notifications/unread-count`).set(bearer(alice.token));
    const unread = count.body.data.unread as number;
    expect(unread).toBeGreaterThanOrEqual(4);
    const list = await api().get(`${S}/me/notifications`).set(bearer(alice.token));
    expect(list.body.meta.tabs.All).toBe(unread);
    expect(list.body.meta.tabs.Orders).toBe(2);
    const first = list.body.data[0].id;
    const read = await api().post(`${S}/me/notifications/${first}/read`).set(bearer(alice.token));
    expect(read.body.data.unread).toBe(false);
    expect((await api().get(`${S}/me/notifications/unread-count`).set(bearer(alice.token))).body.data.unread).toBe(unread - 1);
    const all = await api().post(`${S}/me/notifications/read-all`).set(bearer(alice.token)).send({ category: "Orders" });
    expect(all.body.data.updated).toBeGreaterThanOrEqual(1);
    expect((await api().get(`${S}/me/notifications?category=Orders&unread=true`).set(bearer(alice.token))).body.data).toHaveLength(0);
    const del = await api().delete(`${S}/me/notifications/${first}`).set(bearer(alice.token));
    expect(del.status).toBe(200);
    expect((await api().delete(`${S}/me/notifications/${first}`).set(bearer(alice.token))).status).toBe(404);
  });

  it("staff bell: unread count, read one, read all", async () => {
    const c = await api().get(`${A}/notifications/unread-count`).set(bearer(superAdmin.token));
    expect(c.body.data.unread).toBeGreaterThanOrEqual(2);
    const list = await api().get(`${A}/notifications?unread=true`).set(bearer(superAdmin.token));
    const one = await api().post(`${A}/notifications/${list.body.data[0].id}/read`).set(bearer(superAdmin.token));
    expect(one.body.data.read).toBe(true);
    // someone else's alert is not reachable
    expect((await api().post(`${A}/notifications/${list.body.data[0].id}/read`).set(bearer(marketing.token))).status).toBe(404);
    await api().post(`${A}/notifications/read-all`).set(bearer(superAdmin.token));
    expect((await api().get(`${A}/notifications/unread-count`).set(bearer(superAdmin.token))).body.data.unread).toBe(0);
  });
});

describe("notification preferences", () => {
  it("defaults, partial update, and topics / channels gate push", async () => {
    const g = await api().get(`${S}/me/notification-preferences`).set(bearer(alice.token));
    expect(g.body.data).toEqual({
      channels: { push: true, email: true, sms: false },
      topics: { orders: true, concierge: true, shipping: true, promos: false, wishlist: true },
    });
    const token = `ExponentPushToken[${uniq("tok")}]`;
    expect((await api().post(`${S}/me/push-tokens`).set(bearer(alice.token)).send({ token, platform: "expo" })).status).toBeLessThan(300);
    const sentTo = () => pushOutbox().filter((m) => m.tokens.includes(token)).length;

    const r1 = await notify(alice.customer.id, { category: "Orders", title: "Order Shipped", message: "On its way", push: true });
    expect(r1.delivered.push).toBe(true);
    expect(sentTo()).toBe(1);
    // promos are off by default → inbox row only
    const r2 = await notify(alice.customer.id, { category: "Offers", title: "Exclusive Offer", message: "10% off", push: true });
    expect(r2.notification).not.toBeNull();
    expect(r2.delivered.push).toBe(false);

    const put = await api().put(`${S}/me/notification-preferences`).set(bearer(alice.token)).send({ topics: { orders: false } });
    expect(put.body.data.topics).toMatchObject({ orders: false, concierge: true, promos: false });
    expect(put.body.data.channels.push).toBe(true);
    const r3 = await notify(alice.customer.id, { category: "Orders", title: "Order Delivered", message: "Enjoy", push: true });
    expect(r3.delivered.push).toBe(false);
    expect(sentTo()).toBe(1);

    // channel off → no push even for ungated (account) notices
    await api().put(`${S}/me/notification-preferences`).set(bearer(alice.token)).send({ channels: { push: false } });
    const r4 = await notify(alice.customer.id, { category: "Account", title: "Wallet Topped Up", message: "₦5,000 added", template: { code: "wallet.topup", vars: { amount: "₦5,000" } } });
    expect(r4.delivered.push).toBe(false);
    expect(sentTo()).toBe(1);
    expect(await prisma.notification.count({ where: { customerId: alice.customer.id, title: "Wallet Topped Up" } })).toBe(1);
  });
});

describe("notification settings (staff rules)", () => {
  it("lists the seeded rules and edits them", async () => {
    const g = await api().get(`${A}/notification-settings`).set(bearer(superAdmin.token));
    expect(g.status).toBe(200);
    expect(g.body.data.rules).toHaveLength(12);
    expect(g.body.data.rules[0].category).toBe("orders");
    expect(g.body.data.quietHours.enabled).toBe(false);
    const bad = await api().patch(`${A}/notification-settings/rules/order_new`).set(bearer(superAdmin.token)).send({ recipients: ["not a role"] });
    expect(bad.status).toBe(400);
    const p = await api().patch(`${A}/notification-settings/rules/order_new`).set(bearer(superAdmin.token))
      .send({ priority: "normal", recipients: ["super_admin", "support", "ops@asl.dev"], channels: { slack: true } });
    expect(p.status).toBe(200);
    expect(p.body.data).toMatchObject({ priority: "normal", recipients: ["super_admin", "support", "ops@asl.dev"] });
    expect(p.body.data.channels).toMatchObject({ email: true, in_app: true, slack: true });
    const ch = await api().post(`${A}/notification-settings/rules/order_new/channels/email/toggle`).set(bearer(superAdmin.token));
    expect(ch.body.data.channels.email).toBe(false);
    const qh = await api().patch(`${A}/notification-settings/quiet-hours`).set(bearer(superAdmin.token)).send({ start: "23:00" });
    expect(qh.body.data).toMatchObject({ start: "23:00", end: "07:00", enabled: false });
    const dg = await api().patch(`${A}/notification-settings/digest`).set(bearer(superAdmin.token)).send({ frequency: "weekly" });
    expect(dg.body.data.frequency).toBe("weekly");
    const chans = await api().patch(`${A}/notification-settings/channels`).set(bearer(superAdmin.token)).send({ slack: { channel: "#ops" } });
    expect(chans.body.data.slack.channel).toBe("#ops");
  });

  it("recipients follow the rule; a disabled rule creates no rows", async () => {
    const o = await buyAndPay(alice.token, alice.email);
    // support is now a recipient of order_new
    expect(await prisma.adminNotification.count({ where: { ruleId: "order_new", adminId: support.admin.id, title: { contains: o.number } } })).toBe(1);

    const t = await api().post(`${A}/notification-settings/rules/order_new/toggle`).set(bearer(superAdmin.token));
    expect(t.body.data.enabled).toBe(false);
    const before = await prisma.adminNotification.count({ where: { ruleId: "order_new" } });
    await buyAndPay(alice.token, alice.email);
    expect(await prisma.adminNotification.count({ where: { ruleId: "order_new" } })).toBe(before);
  });

  it("test sends: e-mail to the caller, Slack mocked", async () => {
    mail.outbox!.length = 0;
    const e = await api().post(`${A}/notification-settings/test/email`).set(bearer(superAdmin.token));
    expect(e.status).toBe(200);
    expect(e.body.data.message).toContain("Test email queued");
    expect(mail.outbox!.some((m) => m.to === superAdmin.email && m.subject.includes("Test notification"))).toBe(true);
    const s = await api().post(`${A}/notification-settings/test/slack`).set(bearer(superAdmin.token));
    expect(s.body.data).toMatchObject({ mocked: true });
    expect(s.body.data.message).toContain("#ops");
  });
});

describe("other staff alerts", () => {
  it("stock.low → catalog alerts (deduped per SKU), review → catalog_review, failed payment → finance_failed", async () => {
    const catalogMgr = await createAdmin("catalog_manager");
    const finance = await createAdmin("finance");
    const { events } = await import("@/core/events/bus");
    const v = await prisma.productVariant.findFirstOrThrow({ select: { id: true, sku: true } });
    events.emit("stock.low", { variantId: v.id, sku: v.sku, available: 2 });
    await settle();
    events.emit("stock.low", { variantId: v.id, sku: v.sku, available: 1 });
    events.emit("stock.low", { variantId: v.id, sku: v.sku, available: 0 });
    await settle();
    expect(await prisma.adminNotification.count({ where: { ruleId: "catalog_low_stock", adminId: catalogMgr.admin.id } })).toBe(1);
    expect(await prisma.adminNotification.count({ where: { ruleId: "catalog_oos", adminId: catalogMgr.admin.id } })).toBe(1);

    const p = await prisma.product.findFirstOrThrow({ where: { status: "active" } });
    const rv = await api().post(`${S}/products/${p.handle}/reviews`).set(bearer(alice.token)).send({ rating: 5, title: "Love it", body: "Fits perfectly and feels premium." });
    expect(rv.status).toBe(201);
    await settle();
    expect(await prisma.adminNotification.count({ where: { ruleId: "catalog_review", adminId: { in: [catalogMgr.admin.id, support.admin.id] } } })).toBe(2);

    // failed card payment
    const c = await registerCustomer();
    const prod = await prisma.product.findFirstOrThrow({
      where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(140_000) } },
      include: { variants: true },
    });
    await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: prod.handle, size: prod.variants[0].size, color: prod.variants[0].color, qty: 1 });
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678", subscribe: false }, delivery: "ship", address: lagos });
    const placed = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
    await api().post(`${W}/mock/checkout/${placed.body.data.payment.reference}/complete`).type("form").send({ outcome: "failed" });
    await settle();
    expect(await prisma.adminNotification.count({ where: { ruleId: "finance_failed", adminId: finance.admin.id } })).toBe(1);
  });
});
