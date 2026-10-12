import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { mail } from "@/providers/mail/mail";
import { push } from "@/providers/push/push";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { couponsService, type CouponContext } from "@/modules/commerce/coupons/coupons.service";
import { campaignsService } from "@/modules/marketing/campaigns/campaigns.service";
import { segmentsService } from "@/modules/marketing/segments/segments.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const N = (naira: number) => naira * 100;

let admin: string;
let adminEmail: string;
let support: string;
type C = { id: string; email: string; token: string };
const people: Record<string, C> = {};

const outbox = () => mail.outbox!;
const pushOutbox = () => (push as unknown as { outbox: { tokens: string[]; title: string; body: string; data?: Record<string, string> }[] }).outbox;
const path = (url: string) => url.replace(/^https?:\/\/[^/]+/, "");

async function customer(key: string, p: { tier: "Standard" | "Silver" | "Gold" | "Signature"; spend: number; orders: number; optIn: boolean; tags?: string[]; city?: string; country?: string }) {
  const r = await registerCustomer({ name: `${key} Tester` });
  const id = r.customer.id as string;
  await prisma.customer.update({ where: { id }, data: { tier: p.tier, marketingOptIn: p.optIn, city: p.city ?? "Lagos", country: p.country ?? "NG" } });
  await prisma.customerStats.upsert({
    where: { customerId: id },
    create: { customerId: id, totalSpend: p.spend, ordersCount: p.orders, aov: p.orders ? Math.round(p.spend / p.orders) : 0, lastOrderAt: new Date() },
    update: { totalSpend: p.spend, ordersCount: p.orders, aov: p.orders ? Math.round(p.spend / p.orders) : 0, lastOrderAt: new Date() },
  });
  for (const tag of p.tags ?? []) await prisma.customerTag.create({ data: { customerId: id, tag } });
  people[key] = { id, email: r.email, token: r.token };
}

let goldSpenders: string; // segment: spend > ₦200k AND tier in [Gold]

beforeAll(async () => {
  await resetDb();
  const a = await createAdmin("super_admin");
  admin = a.token;
  adminEmail = a.email;
  support = (await createAdmin("support")).token;
  // A, D match "spend > ₦200k and Gold"; A is the only one of them opted in to marketing
  await customer("Ada", { tier: "Gold", spend: N(500_000), orders: 3, optIn: true, tags: ["sneakers"] });
  await customer("Bola", { tier: "Gold", spend: N(100_000), orders: 1, optIn: true });
  await customer("Chi", { tier: "Signature", spend: N(900_000), orders: 4, optIn: false, city: "London", country: "GB" });
  await customer("Dayo", { tier: "Gold", spend: N(800_000), orders: 2, optIn: false, tags: ["fashion"] });
  await customer("Efe", { tier: "Standard", spend: 0, orders: 0, optIn: true });
}, 240_000);

describe("permissions", () => {
  it("support staff can't open marketing screens", async () => {
    for (const p of ["/segments", "/campaigns", "/messaging/templates", "/messaging/blasts"]) {
      const r = await api().get(`${A}${p}`).set(bearer(support));
      expect(r.status, p).toBe(403);
    }
    expect((await api().get(`${A}/segments`)).status).toBe(401);
  });
});

describe("segments", () => {
  it("compiles rules (spend > X and tier in [Gold]) and previews counts", async () => {
    const r = await api().post(`${A}/segments`).set(bearer(admin)).send({
      name: "Gold big spenders", color: "#B8862B", match: "all",
      rules: [{ field: "spend", op: "gt", value: N(200_000) }, { field: "tier", op: "in", value: ["Gold"] }],
    });
    expect(r.status).toBe(201);
    goldSpenders = r.body.data.id;

    const p = await api().get(`${A}/segments/${goldSpenders}/preview`).set(bearer(admin));
    expect(p.status).toBe(200);
    expect(p.body.data.count).toBe(2);
    expect(p.body.data.marketable).toBe(1);
    expect(p.body.data.spend).toBe(N(1_300_000));
    expect(p.body.data.sample.map((c: { email: string }) => c.email).sort()).toEqual([people.Ada.email, people.Dayo.email].sort());

    // match any + other fields, unsaved
    const any = await api().post(`${A}/segments/preview`).set(bearer(admin)).send({
      match: "any", rules: [{ field: "country", op: "in", value: ["United Kingdom"] }, { field: "tags", op: "in", value: ["sneakers"] }],
    });
    expect(any.body.data.count).toBe(2); // Chi (GB) + Ada (sneakers)
    const lte = await api().post(`${A}/segments/preview`).set(bearer(admin)).send({ match: "all", rules: [{ field: "spend", op: "lte", value: N(100_000) }] });
    expect(lte.body.data.count).toBe(2); // Bola + Efe (no orders)
    const recent = await api().post(`${A}/segments/preview`).set(bearer(admin)).send({ match: "all", rules: [{ field: "createdAt", op: "within_days", value: 1 }, { field: "marketingOptIn", op: "eq", value: true }] });
    expect(recent.body.data.count).toBe(3);

    const bad = await api().post(`${A}/segments/preview`).set(bearer(admin)).send({ match: "all", rules: [{ field: "tier", op: "gt", value: 3 }] });
    expect(bad.status).toBe(400);
  });

  it("lists, paginates, exports, duplicates, pins; built-ins can't be deleted", async () => {
    const list = await api().get(`${A}/segments`).set(bearer(admin));
    expect(list.status).toBe(200);
    const mine = list.body.data.find((s: { id: string }) => s.id === goldSpenders);
    expect(mine.count).toBe(2);
    const vip = list.body.data.find((s: { system: boolean }) => s.system);
    expect(vip).toBeTruthy();
    expect((await api().delete(`${A}/segments/${vip.id}`).set(bearer(admin))).status).toBe(400);

    const page = await api().get(`${A}/segments/${goldSpenders}/customers?pageSize=1`).set(bearer(admin));
    expect(page.body.meta.total).toBe(2);
    expect(page.body.data).toHaveLength(1);
    const csv = await api().get(`${A}/segments/${goldSpenders}/customers/export`).set(bearer(admin));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain(people.Dayo.email);

    const dup = await api().post(`${A}/segments/${goldSpenders}/duplicate`).set(bearer(admin));
    expect(dup.status).toBe(201);
    expect(dup.body.data.name).toBe("Gold big spenders (copy)");
    const pin = await api().post(`${A}/segments/${dup.body.data.id}/pin`).set(bearer(admin));
    expect(pin.body.data.pinned).toBe(true);
    expect((await api().delete(`${A}/segments/${dup.body.data.id}`).set(bearer(admin))).status).toBe(200);

    expect(await segmentsService.isMember(goldSpenders, people.Ada.id)).toBe(true);
    expect(await segmentsService.isMember(goldSpenders, people.Bola.id)).toBe(false);
  });

  it("segment coupons are redeemable only by members", async () => {
    const code = uniq("SEG").toUpperCase();
    const r = await api().post(`${A}/coupons`).set(bearer(admin)).send({
      code, title: "Gold spenders 10%", type: "percent", value: 10, status: "active", eligibility: "segment", segmentId: goldSpenders,
    });
    expect(r.status).toBe(201);
    const ctx = (customerId: string): CouponContext => ({
      customerId, channel: "web", subtotal: N(100_000), shipping: 0,
      lines: [{ productId: "p1", categoryHandle: "men", subcategoryHandle: null, brandHandle: "nike", unitPrice: N(100_000), qty: 1 }],
    });
    const ok = await couponsService.evaluate(code, ctx(people.Ada.id));
    expect(ok.discount).toBe(N(10_000));
    await expect(couponsService.evaluate(code, ctx(people.Bola.id))).rejects.toMatchObject({ code: "COUPON_INVALID" });
  });
});

describe("message templates", () => {
  let tplId: string;

  it("edits, previews with sample data and sends a test", async () => {
    const list = await api().get(`${A}/messaging/templates?channel=email&category=transactional`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.meta.tabs.all).toBeGreaterThan(0);
    const t = list.body.data.find((x: { code: string }) => x.code === "order.confirmed");
    expect(t.channel).toBe("email");
    tplId = t.id;

    const p = await api().patch(`${A}/messaging/templates/${tplId}`).set(bearer(admin)).send({
      subject: "{{firstName}}, order {{orderNumber}} is confirmed", preheader: "Thanks for shopping", body: "Hi {{firstName}},\n\nWe got order {{orderNumber}} ({{total}}).", cta: "See order",
    });
    expect(p.status).toBe(200);
    expect(p.body.data.variables).toEqual(["firstName", "orderNumber", "total", "orderUrl"]);

    const pv = await api().post(`${A}/messaging/templates/${tplId}/preview`).set(bearer(admin)).send({ vars: { firstName: "Zee" } });
    expect(pv.status).toBe(200);
    expect(pv.body.data.subject).toBe("Zee, order ASL-10234 is confirmed");
    expect(pv.body.data.variables).toContain("total");
    expect(pv.body.data.html).toContain("Thanks for shopping");

    const before = outbox().length;
    const test = await api().post(`${A}/messaging/templates/${tplId}/test`).set(bearer(admin)).send({});
    expect(test.status).toBe(200);
    const sent = outbox().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(adminEmail);
    expect(sent[0].subject).toMatch(/^\[Test\] .*order ASL-10234 is confirmed$/);

    // the system now sends the edited text
    await messaging.email(people.Ada.email, "order.confirmed", { firstName: "Ada", orderNumber: "ASL-1", total: "₦1", orderUrl: "http://x/1" });
    expect(outbox().at(-1)!.subject).toBe("Ada, order ASL-1 is confirmed");
  });

  it("paused templates are not sent; reset restores the default", async () => {
    const st = await api().patch(`${A}/messaging/templates/${tplId}/status`).set(bearer(admin)).send({ status: "paused" });
    expect(st.body.data.status).toBe("paused");
    const before = outbox().length;
    await messaging.email(people.Ada.email, "order.confirmed", { firstName: "Ada", orderNumber: "ASL-2" });
    expect(outbox().length).toBe(before);

    const reset = await api().post(`${A}/messaging/templates/${tplId}/reset`).set(bearer(admin));
    expect(reset.body.data.status).toBe("active");
    expect(reset.body.data.subject).toBe("Order {{orderNumber}} confirmed");

    const dup = await api().post(`${A}/messaging/templates/${tplId}/duplicate`).set(bearer(admin));
    expect(dup.status).toBe(201);
    expect(dup.body.data).toMatchObject({ code: "order.confirmed.copy", status: "draft" });
    expect((await api().delete(`${A}/messaging/templates/${dup.body.data.id}`).set(bearer(admin))).status).toBe(200);
    expect((await api().delete(`${A}/messaging/templates/${tplId}`).set(bearer(admin))).status).toBe(400);
  });
});

describe("campaigns", () => {
  let campaignId: string;
  let token: string;

  it("sends to the segment's opted-in customers only, with tracking and unsubscribe links", async () => {
    const c = await api().post(`${A}/campaigns`).set(bearer(admin)).send({
      name: "Autumn icons", subject: "{{firstName}}, the Autumn edit is live", preheader: "Early access", channel: "email", goal: "launch",
      segmentId: goldSpenders, body: "Hi {{firstName}},\n\nYour early access starts now.", cta: { label: "Shop the drop", url: "/new-arrivals" }, tags: ["drop"],
    });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ status: "draft", segmentName: "Gold big spenders" });
    campaignId = c.body.data.id;

    expect((await api().patch(`${A}/campaigns/${campaignId}`).set(bearer(admin)).send({ ctaUrl: "https://evil.example/x" })).status).toBe(400);

    const before = outbox().length;
    const test = await api().post(`${A}/campaigns/${campaignId}/send-test`).set(bearer(admin)).send({});
    expect(test.status).toBe(200);
    expect(outbox().length).toBe(before + 1);
    expect(outbox().at(-1)!.subject).toMatch(/^\[Test\]/);

    const now = await api().post(`${A}/campaigns/${campaignId}/send-now`).set(bearer(admin));
    expect(now.status).toBe(200);
    await settle();

    const got = await api().get(`${A}/campaigns/${campaignId}`).set(bearer(admin));
    expect(got.body.data).toMatchObject({ status: "sent", audienceSize: 1, sent: 1, delivered: 1 });
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId } });
    expect(recipients.map((r) => r.customerId)).toEqual([people.Ada.id]); // Dayo matches but isn't opted in

    const mails = outbox().slice(before + 1).filter((m) => m.subject.includes("Autumn edit"));
    expect(mails.map((m) => m.to)).toEqual([people.Ada.email]);
    const html = mails[0].html;
    expect(mails[0].subject).toBe("Ada, the Autumn edit is live");
    const pixel = html.match(/src="([^"]+\/t\/o\/[^"]+)"/)![1];
    const click = html.match(/href="([^"]+\/t\/c\/[^"]+)"/)![1].replace(/&amp;/g, "&");
    const unsub = html.match(/href="([^"]+\/unsubscribe\/[^"]+)"/)![1];
    token = recipients[0].token;
    expect(pixel).toContain(token);
    expect(decodeURIComponent(click)).toContain("utm_campaign=autumn-icons");

    const o = await api().get(path(pixel));
    expect(o.status).toBe(200);
    expect(o.headers["content-type"]).toBe("image/gif");
    await api().get(path(pixel)); // second open is not counted again

    const cl = await api().get(path(click));
    expect(cl.status).toBe(302);
    expect(cl.headers.location).toMatch(new RegExp(`^${env.WEB_URL.replace(/\/$/, "")}/new-arrivals\\?utm_source=asl&utm_medium=email&utm_campaign=autumn-icons$`));

    const stats = (await api().get(`${A}/campaigns/${campaignId}`).set(bearer(admin))).body.data;
    expect(stats).toMatchObject({ opened: 1, clicked: 1, unsubscribed: 0 });

    const confirm = await api().get(path(unsub));
    expect(confirm.text).toContain("<form method=\"post\"");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: people.Ada.id } })).marketingOptIn).toBe(true);
    const un = await api().post(path(unsub));
    expect(un.status).toBe(200);
    expect(un.text).toContain("unsubscribed");
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: people.Ada.id } })).marketingOptIn).toBe(false);
    expect((await api().get(`${A}/campaigns/${campaignId}`).set(bearer(admin))).body.data.unsubscribed).toBe(1);
    expect((await api().post(`/unsubscribe/nope-not-a-token`)).status).toBe(404);
    await prisma.customer.update({ where: { id: people.Ada.id }, data: { marketingOptIn: true } });

    const list = await api().get(`${A}/campaigns?status=sent`).set(bearer(admin));
    expect(list.body.meta.tabs.sent).toBe(1);
    expect(list.body.meta.kpis.clicked).toBe(1);
  });

  it("click redirect refuses foreign hosts", async () => {
    for (const u of ["https://evil.example/phish", "//evil.example/x", "javascript:alert(1)", "/\\evil.example"]) {
      const r = await api().get(`/t/c/${token}`).query({ u });
      expect(r.status, u).toBe(400);
    }
    const ok = await api().get(`/t/c/${token}`).query({ u: "/shop" });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe(`${env.WEB_URL.replace(/\/$/, "")}/shop`);
  });

  it("scheduled campaigns go out from the dispatch job; pause / archive / duplicate", async () => {
    const c = (await api().post(`${A}/campaigns`).set(bearer(admin)).send({ name: "Inbox note", subject: "A note for you", channel: "inapp", segmentId: goldSpenders, body: "Hello {{firstName}}" })).body.data;
    const sch = await api().patch(`${A}/campaigns/${c.id}/status`).set(bearer(admin)).send({ action: "schedule", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(sch.body.data.status).toBe("scheduled");
    expect(await campaignsService.dispatchDue()).toBe(0);
    const pause = await api().patch(`${A}/campaigns/${c.id}/status`).set(bearer(admin)).send({ action: "pause" });
    expect(pause.body.data.status).toBe("paused");
    await api().patch(`${A}/campaigns/${c.id}/status`).set(bearer(admin)).send({ action: "resume", scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await prisma.campaign.update({ where: { id: c.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
    expect(await campaignsService.dispatchDue()).toBe(1);

    const done = (await api().get(`${A}/campaigns/${c.id}`).set(bearer(admin))).body.data;
    expect(done).toMatchObject({ status: "sent", audienceSize: 2, delivered: 2 }); // in-app: no opt-in needed
    const inbox = await prisma.notification.findMany({ where: { customerId: { in: [people.Ada.id, people.Dayo.id] }, title: "A note for you" } });
    expect(inbox).toHaveLength(2);

    expect((await api().patch(`${A}/campaigns/${c.id}`).set(bearer(admin)).send({ name: "x" })).status).toBe(400);
    const arch = await api().patch(`${A}/campaigns/${c.id}/status`).set(bearer(admin)).send({ action: "archive" });
    expect(arch.body.data.status).toBe("archived");
    const dup = await api().post(`${A}/campaigns/${c.id}/duplicate`).set(bearer(admin));
    expect(dup.body.data).toMatchObject({ status: "draft", sent: 0, name: "Inbox note (copy)" });
    expect((await api().post(`${A}/campaigns/${dup.body.data.id}/pin`).set(bearer(admin))).body.data.pinned).toBe(true);
  });
});

describe("push blasts", () => {
  it("send-now reaches customers with push tokens", async () => {
    const pushToken = `ExponentPushToken[${uniq("tok")}]`;
    const reg = await api().post(`${S}/me/push-tokens`).set(bearer(people.Bola.token)).send({ token: pushToken, platform: "expo" });
    expect(reg.status).toBeLessThan(300);

    const b = await api().post(`${A}/messaging/blasts`).set(bearer(admin)).send({ title: "VIP preview at 6PM", body: "Signature members first.", audience: "all" });
    expect(b.status).toBe(201);
    expect(b.body.data).toMatchObject({ status: "draft", audienceLabel: "All app users" });
    const detail = await api().get(`${A}/messaging/blasts/${b.body.data.id}`).set(bearer(admin));
    expect(detail.body.data.audienceSize).toBe(1);

    const before = pushOutbox().length;
    const send = await api().post(`${A}/messaging/blasts/${b.body.data.id}/send-now`).set(bearer(admin));
    expect(send.status).toBe(200);
    await settle();
    const sent = pushOutbox().slice(before).filter((m) => m.title === "VIP preview at 6PM");
    expect(sent).toHaveLength(1);
    expect(sent[0].tokens).toEqual([pushToken]);
    expect(sent[0].data?.blastId).toBe(b.body.data.id);

    const after = await api().get(`${A}/messaging/blasts/${b.body.data.id}`).set(bearer(admin));
    expect(after.body.data).toMatchObject({ status: "sent", recipients: 1, opens: 0 });
    await api().post(`${S}/push/opened`).send({ blastId: b.body.data.id });
    expect((await api().get(`${A}/messaging/blasts/${b.body.data.id}`).set(bearer(admin))).body.data.opens).toBe(1);
    expect((await api().post(`${A}/messaging/blasts/${b.body.data.id}/send-now`).set(bearer(admin))).status).toBe(400);

    // segment audience without push tokens → nobody
    const seg = await api().post(`${A}/messaging/blasts`).set(bearer(admin)).send({ title: "Gold only", body: "x", audience: "segment", segmentId: goldSpenders });
    expect((await api().get(`${A}/messaging/blasts/${seg.body.data.id}`).set(bearer(admin))).body.data).toMatchObject({ audienceSize: 0, audienceLabel: "Gold big spenders" });
    const list = await api().get(`${A}/messaging/blasts`).set(bearer(admin));
    expect(list.body.meta.tabs).toMatchObject({ all: 2, sent: 1, draft: 1 });
  });
});
