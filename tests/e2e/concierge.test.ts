import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";
import { requestsService } from "@/modules/concierge/requests/requests.service";
import { quotesService } from "@/modules/concierge/quotes/quotes.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let superAdmin: string;
let agent: { token: string; id: string };
let support: string;
let alice: Awaited<ReturnType<typeof registerCustomer>>;
let bob: Awaited<ReturnType<typeof registerCustomer>>;
let png: Buffer;

const address = { fullName: "Alice Ade", phone: "+2348012345678", address: "12 Admiralty Way", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function submit(token: string, fields: Record<string, string> = {}) {
  const req = api().post(`${S}/concierge/requests`).set(bearer(token));
  const all = { itemName: "Air Jordan 1 Retro High OG", category: "Footwear", brand: "Jordan", size: "UK 9", color: "Black/Red", budget: String(N(300_000)), ...fields };
  for (const [k, v] of Object.entries(all)) req.field(k, v);
  return req.attach("images", png, { filename: "ref.png", contentType: "image/png" });
}

const quote = (id: string, body: Record<string, unknown> = {}, token = agent.token) =>
  api().post(`${A}/concierge/requests/${id}/quotes`).set(bearer(token)).send({ lines: [{ name: "AJ1 Black Toe UK 9", source: "StockX", qty: 1, price: N(280_000) }], note: "Brand new, full box", ...body });

const accept = (token: string, id: string, body: Record<string, unknown> = { address }) =>
  api().post(`${S}/concierge/requests/${id}/quote/accept`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send(body);

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  expect(r.status).toBe(200);
  await settle();
}

const setStatus = (id: string, status: string, token = agent.token) => api().patch(`${A}/concierge/requests/${id}/status`).set(bearer(token)).send({ status });

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  superAdmin = (await createAdmin("super_admin")).token;
  const a = await createAdmin("concierge_agent");
  agent = { token: a.token, id: a.admin.id };
  support = (await createAdmin("support")).token;
  alice = await registerCustomer({ name: "Alice Ade" });
  bob = await registerCustomer({ name: "Bob Bello" });
  png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#cc5000" } }).png().toBuffer();
}, 240_000);

describe("request → quote → payment → delivered", () => {
  let id = "";
  let number = "";

  it("customer submits a request with a reference image", async () => {
    mail.outbox!.length = 0;
    const r = await submit(alice.token);
    expect(r.status).toBe(201);
    const d = r.body.data;
    id = d.id;
    number = d.number;
    expect(number).toMatch(/^ASL\d{6,}$/);
    expect(d.images).toHaveLength(1);
    expect(d.statusKey).toBe("new");
    expect(d.status).toBe("Sourcing");
    expect(d.cartStatus).toBe("Sourcing in Progress");
    expect(d.trackStep).toBe(0);
    expect(d.contact.email).toBe(alice.email);
    await settle();
    expect(mail.outbox!.some((m) => m.to === alice.email && m.subject.includes(number))).toBe(true);
    // staff rule concierge_request → in-app notification for the concierge_agent role
    expect(await prisma.adminNotification.count({ where: { ruleId: "concierge_request", role: "concierge_agent" } })).toBe(1);
    const row = await prisma.conciergeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.slaDueAt!.getTime() - row.createdAt.getTime()).toBe(48 * 3_600_000);

    const mine = await api().get(`${S}/concierge/requests?tab=progress`).set(bearer(alice.token));
    expect(mine.body.data.map((x: { id: string }) => x.id)).toContain(id);
    expect(mine.body.meta.tabs).toMatchObject({ all: 1, progress: 1, completed: 0, cancelled: 0 });
  });

  it("another customer can't see it", async () => {
    expect((await api().get(`${S}/concierge/requests/${id}`).set(bearer(bob.token))).status).toBe(404);
    expect((await api().get(`${S}/concierge/requests/${id}/messages`).set(bearer(bob.token))).status).toBe(404);
    expect((await api().get(`${S}/concierge/requests/${id}/quote`).set(bearer(bob.token))).status).toBe(404);
  });

  it("admin inbox lists it; agent assigns themself → sourcing", async () => {
    const inbox = await api().get(`${A}/concierge/requests?tab=unassigned&q=${number}`).set(bearer(agent.token));
    expect(inbox.status).toBe(200);
    expect(inbox.body.data[0].id).toBe(id);
    expect(inbox.body.meta.kpis.unassigned).toBeGreaterThanOrEqual(1);
    expect(inbox.body.data[0].sla).toBe("ok");

    const res = await api().post(`${A}/concierge/requests/${id}/assign`).set(bearer(agent.token)).send({ adminId: agent.id });
    expect(res.status).toBe(200);
    expect(res.body.data.assignee.id).toBe(agent.id);
    expect(res.body.data.status).toBe("sourcing");
    // internal note is in the admin timeline only
    expect(res.body.data.timeline.some((t: { internal: boolean; text: string }) => t.internal && t.text.startsWith("Assigned"))).toBe(true);
    const mine = await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token));
    expect(mine.body.data.timeline.some((t: { text: string }) => t.text.startsWith("Assigned"))).toBe(false);

    const bad = await api().patch(`${A}/concierge/requests/${id}/status`).set(bearer(agent.token)).send({ status: "delivered" });
    expect(bad.status).toBe(409);
  });

  it("support can't quote; concierge agent can (defaults from settings, VAT inclusive)", async () => {
    expect((await quote(id, {}, support)).status).toBe(403);
    mail.outbox!.length = 0;
    const q = await quote(id);
    expect(q.status).toBe(201);
    const d = q.body.data;
    expect(d.number).toMatch(/^QT-\d+$/);
    expect(d.itemsTotal).toBe(N(280_000));
    expect(d.serviceFee).toBe(N(50_500));
    expect(d.shippingEstimate).toBe(N(35_000));
    expect(d.tax).toBe(0);
    expect(d.taxIncluded).toBeGreaterThan(0);
    expect(d.total).toBe(N(365_500));
    expect(d.depositPct).toBe(100);
    expect(d.deposit).toBe(d.total);
    expect(new Date(d.expiresAt).getTime() - Date.now()).toBeGreaterThan(71 * 3_600_000);
    await settle();
    expect(mail.outbox!.some((m) => m.to === alice.email && /quote/i.test(m.subject))).toBe(true);
  });

  it("customer sees the quote: cart label Payment Pending", async () => {
    const r = await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token));
    expect(r.body.data.statusKey).toBe("quoted");
    expect(r.body.data.cartStatus).toBe("Payment Pending");
    expect(r.body.data.currentQuote.total).toBe(N(365_500));
    const q = await api().get(`${S}/concierge/requests/${number}/quote`).set(bearer(alice.token));
    expect(q.status).toBe(200);
    expect(q.body.data.quote.lines).toHaveLength(1);
    expect(q.body.data.quote.amountDueNow).toBe(N(365_500));
    const cart = await api().get(`${S}/concierge/cart`).set(bearer(alice.token));
    expect(cart.body.data.items.find((i: { id: string }) => i.id === id).cartStatus).toBe("Payment Pending");
  });

  it("chat both ways with unread counts", async () => {
    // system lines (opened, sourcing, quote) are unread for the customer
    const u0 = await api().get(`${S}/concierge/unread`).set(bearer(alice.token));
    expect(u0.body.data.total).toBeGreaterThanOrEqual(3);
    const read = await api().get(`${S}/concierge/requests/${id}/messages`).set(bearer(alice.token));
    expect(read.status).toBe(200);
    expect(read.body.data.messages.some((m: { quote: unknown }) => m.quote)).toBe(true);
    expect((await api().get(`${S}/concierge/unread`).set(bearer(alice.token))).body.data.total).toBe(0);

    const sent = await api().post(`${S}/concierge/requests/${id}/messages`).set(bearer(alice.token)).field("text", "Is it the 2025 release?").attach("attachments", png, { filename: "box.png", contentType: "image/png" });
    expect(sent.status).toBe(201);
    expect(sent.body.data.attachments).toHaveLength(1);

    const threads = await api().get(`${A}/concierge/threads?filter=unread`).set(bearer(agent.token));
    const t = threads.body.data.find((x: { requestId: string }) => x.requestId === id);
    expect(t.unread).toBe(1);
    expect(threads.body.meta.totalUnread).toBeGreaterThanOrEqual(1);
    const adminRead = await api().get(`${A}/concierge/threads/${number}/messages`).set(bearer(agent.token));
    expect(adminRead.body.data.messages.at(-1).text).toBe("Is it the 2025 release?");
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { requestId: id } })).unreadAgent).toBe(0);

    const reply = await api().post(`${A}/concierge/threads/${id}/messages`).set(bearer(support)).field("text", "Yes - 2025 pair, receipt included.");
    expect(reply.status).toBe(201);
    expect((await api().get(`${S}/concierge/unread`).set(bearer(alice.token))).body.data.total).toBe(1);
    const again = await api().get(`${S}/concierge/requests/${id}/messages`).set(bearer(alice.token));
    expect(again.body.data.messages.at(-1)).toMatchObject({ sender: "agent", text: "Yes - 2025 pair, receipt included." });
    expect((await api().get(`${S}/concierge/unread`).set(bearer(alice.token))).body.data.total).toBe(0);

    const pin = await api().post(`${A}/concierge/threads/${id}/pin`).set(bearer(agent.token)).send({ pinned: true });
    expect(pin.body.data.pinned).toBe(true);
  });

  it("accepts and pays via the mock gateway → ordered, deposit journaled to 2200", async () => {
    const acc = await accept(alice.token, id);
    expect(acc.status).toBe(200);
    expect(acc.body.data.payment.amount).toBe(N(365_500));
    expect(acc.body.data.payment.authorizationUrl).toBeTruthy();
    const ref = acc.body.data.payment.reference as string;
    const pending = await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token));
    expect(pending.body.data.statusKey).toBe("payment_pending");
    expect(pending.body.data.deliveryAddress.city).toBe("Lekki");

    await payMock(ref);
    const r = await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token));
    expect(r.body.data.statusKey).toBe("ordered");
    expect(r.body.data.status).toBe("Order Confirmed");
    expect(r.body.data.currentQuote).toMatchObject({ status: "paid", amountPaid: N(365_500), balanceDue: 0 });
    expect(r.body.data.canCancel).toBe(false);

    const je = await prisma.journalEntry.findFirst({ where: { reference: ref, source: "order" }, include: { lines: true } });
    expect(je).toBeTruthy();
    expect(Number(je!.lines.find((l) => l.accountCode === "2200")!.credit)).toBe(N(365_500));
    expect(Number(je!.lines.find((l) => l.accountCode === "1010")!.debit)).toBe(N(365_500));
    expect(await prisma.adminNotification.count({ where: { ruleId: "concierge_quote" } })).toBeGreaterThanOrEqual(1);

    // can't cancel once paid
    expect((await api().post(`${S}/concierge/requests/${id}/cancel`).set(bearer(alice.token)).send({})).status).toBe(409);
  });

  it("admin advances to delivered → revenue moved out of deposits", async () => {
    mail.outbox!.length = 0;
    expect((await setStatus(id, "in_transit")).body.data.status).toBe("in_transit");
    const d = await setStatus(id, "delivered");
    expect(d.status).toBe(200);
    expect(d.body.data.status).toBe("delivered");
    await settle();
    expect(mail.outbox!.some((m) => m.to === alice.email && m.subject.includes(number) && m.subject.includes("Completed"))).toBe(true);

    const je = await prisma.journalEntry.findFirst({ where: { reference: number, source: "order" }, include: { lines: true } });
    expect(je).toBeTruthy();
    const line = (code: string) => je!.lines.find((l) => l.accountCode === code);
    expect(Number(line("2200")!.debit)).toBe(N(365_500));
    expect(Number(line("4200")!.credit)).toBe(N(50_500));
    expect(Number(line("2100")!.credit)).toBeGreaterThan(0);
    const credits = je!.lines.reduce((n, l) => n + Number(l.credit), 0);
    expect(credits).toBe(N(365_500));

    const mine = await api().get(`${S}/concierge/requests?tab=completed`).set(bearer(alice.token));
    expect(mine.body.data[0]).toMatchObject({ id, status: "Completed" });
    expect((await setStatus(id, "sourcing")).status).toBe(409);
  });
});

describe("decline, expiry, deposits", () => {
  it("customer declines a quote → back to sourcing; declining with cancel closes it", async () => {
    const id = (await submit(alice.token, { itemName: "Keepall 50" })).body.data.id;
    expect((await quote(id)).status).toBe(201);
    const d = await api().post(`${S}/concierge/requests/${id}/quote/decline`).set(bearer(alice.token)).send({ reason: "Too expensive" });
    expect(d.status).toBe(200);
    expect(d.body.data.quote).toMatchObject({ status: "declined", declineReason: "Too expensive" });
    expect(d.body.data.request.statusKey).toBe("sourcing");
    // a new quote, declined with cancelRequest
    expect((await quote(id, { lines: [{ name: "Keepall 50 (pre-owned)", qty: 1, price: N(400_000) }] })).status).toBe(201);
    const c = await api().post(`${S}/concierge/requests/${id}/quote/decline`).set(bearer(alice.token)).send({ reason: "Changed my mind", cancelRequest: true });
    expect(c.body.data.request.statusKey).toBe("cancelled");
    // a declined quote can't be accepted
    expect((await accept(alice.token, id)).status).toBe(409);
  });

  it("expired quote → 409 QUOTE_EXPIRED; the job expires the rest", async () => {
    const id = (await submit(alice.token, { itemName: "Birkin 25" })).body.data.id;
    const q = (await quote(id)).body.data;
    await prisma.conciergeQuote.update({ where: { id: q.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const r = await accept(alice.token, id);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("QUOTE_EXPIRED");
    expect((await prisma.conciergeQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("expired");
    expect((await prisma.conciergeRequest.findUniqueOrThrow({ where: { id } })).status).toBe("sourcing");

    const id2 = (await submit(alice.token, { itemName: "Kelly 25" })).body.data.id;
    const q2 = (await quote(id2, { validityHours: 1 })).body.data;
    expect(await quotesService.expireDue(new Date(Date.now() + 2 * 3_600_000))).toBeGreaterThanOrEqual(1);
    expect((await prisma.conciergeQuote.findUniqueOrThrow({ where: { id: q2.id } })).status).toBe("expired");
    const list = await api().get(`${A}/concierge/quotes?tab=expired`).set(bearer(agent.token));
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([q.id, q2.id]));
  });

  it("30 % deposit → approved (Ready to Purchase) with balance due → pay balance → ordered", async () => {
    const id = (await submit(alice.token, { itemName: "Royal Oak 15500ST" })).body.data.id;
    const q = (await quote(id, { depositPct: 30, lines: [{ name: "Royal Oak", qty: 1, price: N(1_000_000) }] })).body.data;
    expect(q.deposit).toBe(Math.round((q.total * 30) / 100));
    const acc = await accept(alice.token, id);
    expect(acc.body.data.payment.amount).toBe(q.deposit);
    await payMock(acc.body.data.payment.reference);
    let r = (await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token))).body.data;
    expect(r.statusKey).toBe("approved");
    expect(r.cartStatus).toBe("Ready to Purchase");
    expect(r.currentQuote.balanceDue).toBe(q.total - q.deposit);

    const early = await setStatus(id, "ordered");
    expect(early.status).toBe(200);
    expect((await setStatus(id, "in_transit")).status).toBe(409); // balance before dispatch

    const bal = await api().post(`${S}/concierge/requests/${id}/pay-balance`).set(bearer(alice.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(bal.status).toBe(200);
    expect(bal.body.data.payment.amount).toBe(q.total - q.deposit);
    await payMock(bal.body.data.payment.reference);
    r = (await api().get(`${S}/concierge/requests/${id}`).set(bearer(alice.token))).body.data;
    expect(r.currentQuote).toMatchObject({ amountPaid: q.total, balanceDue: 0 });
    expect((await setStatus(id, "in_transit")).status).toBe(200);
  });

  it("customer cancels before paying", async () => {
    const id = (await submit(alice.token, { itemName: "Dior B22" })).body.data.id;
    const c = await api().post(`${S}/concierge/requests/${id}/cancel`).set(bearer(alice.token)).send({ reason: "Found it elsewhere" });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ statusKey: "cancelled", status: "Cancelled", canCancel: false });
  });
});

describe("guests, catalogue items, tracking", () => {
  it("guests must leave contact details; track by number + e-mail", async () => {
    const noContact = await api().post(`${S}/concierge/requests`).send({ itemName: "Cartier Love", category: "Jewellery" });
    expect(noContact.status).toBe(400);
    const email = `${uniq("g")}@test.dev`;
    const g = await api().post(`${S}/concierge/requests`).send({ itemName: "Cartier Love", category: "Jewellery", contactName: "Guest Person", contactEmail: email });
    expect(g.status).toBe(201);
    const num = g.body.data.number;
    expect(g.body.data.contact).toBeUndefined();

    const t = await api().get(`${S}/concierge/track/${num}?email=${encodeURIComponent(email)}`);
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ number: num, status: "Sourcing", trackStep: 0 });
    expect((await api().get(`${S}/concierge/track/${num}?email=someone@else.dev`)).status).toBe(404);
    expect((await api().get(`${S}/concierge/track/${num}`)).status).toBe(404);
    // owner doesn't need the e-mail
    const mine = (await api().get(`${S}/concierge/requests?tab=all`).set(bearer(alice.token))).body.data[0];
    expect((await api().get(`${S}/concierge/track/${mine.number}`).set(bearer(alice.token))).status).toBe(200);
  });

  it("a concierge-shop product becomes a catalog request with its price", async () => {
    const p = await prisma.product.findFirst({ where: { status: "active" }, include: { variants: true, colors: true }, orderBy: { isConcierge: "desc" } });
    const size = p!.variants.find((v) => v.size)?.size ?? undefined;
    const r = await api().post(`${S}/concierge/requests`).set(bearer(bob.token)).send({ source: "catalog", productId: p!.handle, size, color: p!.colors[0]?.name });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ source: "catalog", productId: p!.id, itemName: p!.name, cartStatus: "Sourcing in Progress" });
    if (size) {
      const noSize = await api().post(`${S}/concierge/requests`).set(bearer(bob.token)).send({ source: "catalog", productId: p!.handle });
      expect(noSize.status).toBe(400);
    }
  });
});

describe("admin tools", () => {
  it("SLA check flags breached requests once and notifies staff", async () => {
    const id = (await submit(bob.token, { itemName: "Saint Louis GM" })).body.data.id;
    await prisma.conciergeRequest.update({ where: { id }, data: { slaDueAt: new Date(Date.now() - 60_000) } });
    const changed = await requestsService.slaCheck();
    expect(changed.find((c) => c.id === id)?.level).toBe("breached");
    expect((await requestsService.slaCheck()).find((c) => c.id === id)).toBeUndefined();
    expect(await prisma.adminNotification.count({ where: { ruleId: "concierge_sla" } })).toBeGreaterThanOrEqual(1);
    const inbox = await api().get(`${A}/concierge/requests?tab=sla_breached`).set(bearer(agent.token));
    expect(inbox.body.data.map((r: { id: string }) => r.id)).toContain(id);
    expect(inbox.body.data[0].slaBreached).toBe(true);
    const k = await api().get(`${A}/concierge/kpis`).set(bearer(support));
    expect(k.status).toBe(200);
    expect(k.body.data.slaBreached).toBeGreaterThanOrEqual(1);
    expect(k.body.data.conversion).toBeGreaterThan(0);
    const board = await api().get(`${A}/concierge/requests/board`).set(bearer(agent.token));
    expect(board.body.data.find((c: { status: string }) => c.status === "delivered").count).toBeGreaterThanOrEqual(1);
  });

  it("suppliers CRUD + link to a request", async () => {
    const created = await api().post(`${A}/concierge/suppliers`).set(bearer(agent.token)).send({
      name: "Milano Luxe Sourcing", contact: "Alessandro Ricci", email: "a.ricci@milanoluxe.it", phone: "+39 02 5555 1200",
      country: "Italy", city: "Milan", categories: ["Footwear"], brands: ["Prada"], tier: "diamond", status: "active", currency: "EUR",
    });
    expect(created.status).toBe(201);
    const sid = created.body.data.id;
    expect((await api().post(`${A}/concierge/suppliers`).set(bearer(support)).send({})).status).toBe(403);
    const patched = await api().patch(`${A}/concierge/suppliers/${sid}`).set(bearer(agent.token)).send({ notes: "Preferred EU partner" });
    expect(patched.body.data).toMatchObject({ notes: "Preferred EU partner", tier: "diamond", status: "active" });
    expect((await api().post(`${A}/concierge/suppliers/${sid}/vip`).set(bearer(agent.token))).body.data.vip).toBe(true);

    const reqId = (await submit(bob.token, { itemName: "Prada loafers" })).body.data.id;
    const linked = await api().patch(`${A}/concierge/requests/${reqId}/supplier`).set(bearer(agent.token)).send({ supplierId: sid });
    expect(linked.body.data.supplier.id).toBe(sid);
    const list = await api().get(`${A}/concierge/suppliers?tab=active`).set(bearer(support));
    expect(list.body.meta.kpis.vip).toBe(1);
    const one = await api().get(`${A}/concierge/suppliers/${sid}`).set(bearer(support));
    expect(one.body.data.stats).toMatchObject({ requests: 1, open: 1 });
    expect((await api().delete(`${A}/concierge/suppliers/${sid}`).set(bearer(superAdmin))).status).toBe(409);
    expect((await api().get(`${A}/concierge/suppliers/export`).set(bearer(support))).headers["content-type"]).toContain("text/csv");
  });
});
