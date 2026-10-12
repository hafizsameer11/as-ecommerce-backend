/**
 * asl-admin /campaigns: marketing sends to a segment over email / push / SMS / WhatsApp / in-app inbox.
 *
 * Sending: `campaigns.dispatch` (every minute) picks scheduled campaigns that are due → status `sending` →
 * one CampaignRecipient per audience customer (email/SMS/WhatsApp only to marketingOptIn customers; never
 * deleted or blocked accounts) → delivered in batches → `sent`. Pausing stops between batches; resume continues.
 * Tracking: open pixel, click redirect (own hosts only) and unsubscribe link carry the recipient token.
 * Conversions = paid orders by recipients within 7 days of their click (computed on read).
 */
import crypto from "node:crypto";
import { Prisma, type Campaign } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { env } from "@/config/env";
import { mail } from "@/providers/mail/mail";
import { sms } from "@/providers/sms/sms";
import { push } from "@/providers/push/push";
import { fill, messaging } from "@/modules/marketing/messaging/messaging.service";
import { segmentsService } from "@/modules/marketing/segments/segments.service";
import { notify } from "@/modules/support/notifications/notifications.service";
import type { CampaignBody, CampaignListQuery, CampaignPatch, CampaignStatusBody, SendTestBody } from "./campaigns.schemas";

const BATCH = 100;
const ATTRIBUTION_DAYS = 7;
const web = env.WEB_URL.replace(/\/$/, "");
const api = env.APP_URL.replace(/\/$/, "");
const EDITABLE: Campaign["status"][] = ["draft", "scheduled", "paused"];

type Utm = { source: string; medium: string; campaign: string };
type Recipient = { id: string; firstName: string; lastName: string; email: string; phone: string | null };

// ── links ──

/** hosts the click redirect may send people to: the storefront and this API */
export const allowedHosts = () => new Set([new URL(env.WEB_URL).host, new URL(env.APP_URL).host]);

/** absolute URL on an allowed host, or null (relative paths resolve on the storefront) */
export function safeTarget(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\")) return `${web}${s}`;
  try {
    const u = new URL(s);
    if ((u.protocol === "https:" || u.protocol === "http:") && allowedHosts().has(u.host)) return u.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function landingUrl(c: Campaign) {
  const target = safeTarget(c.ctaUrl);
  if (!target) return null;
  const u = new URL(target);
  const utm = (c.utm as Utm | null) ?? { source: "asl", medium: c.channel, campaign: slug(c.name) };
  if (utm.source && !u.searchParams.has("utm_source")) u.searchParams.set("utm_source", utm.source);
  if (utm.medium && !u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", utm.medium);
  if (utm.campaign && !u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", utm.campaign);
  return u.toString();
}

const trackedClick = (token: string, url: string) => `${api}/t/c/${token}?u=${encodeURIComponent(url)}`;
const openPixel = (token: string) => `${api}/t/o/${token}`;
export const unsubscribeUrl = (token: string) => `${api}/unsubscribe/${token}`;

const varsFor = (r: Pick<Recipient, "firstName" | "lastName" | "email">) => ({
  firstName: r.firstName || "there", lastName: r.lastName, name: `${r.firstName} ${r.lastName}`.trim() || "there", email: r.email,
});

// ── one message ──

async function sendOne(c: Campaign, r: Recipient, token: string | null) {
  const vars = varsFor(r);
  const subject = fill(c.subject, vars);
  const body = fill(c.body, vars);
  const landing = landingUrl(c);
  const link = landing ? (token ? trackedClick(token, landing) : landing) : undefined;
  switch (c.channel) {
    case "email": {
      const unsub = token ? unsubscribeUrl(token) : `${web}/account/settings`;
      const footerHtml =
        `<p style="margin-top:16px;font-size:12px;color:#777">You're receiving this because you opted in to ASL ORIGINALS news. ` +
        `<a href="${unsub}" style="color:#777">Unsubscribe</a></p>` +
        (token ? `<img src="${openPixel(token)}" width="1" height="1" alt="" style="display:block;border:0">` : "");
      const html = await messaging.emailHtml(subject, body, c.ctaLabel || undefined, link, { preheader: c.preheader ? fill(c.preheader, vars) : undefined, footerHtml });
      const text = [body, c.ctaLabel && link ? `${c.ctaLabel}: ${link}` : "", `Unsubscribe: ${unsub}`].filter(Boolean).join("\n\n");
      await mail.send({ to: r.email, subject, html, text });
      return;
    }
    case "sms":
    case "whatsapp": {
      if (!r.phone) throw new Error("no phone number");
      const stop = token ? ` Opt out: ${unsubscribeUrl(token)}` : "";
      await sms.send({ to: r.phone, body: `${body}${link ? ` ${link}` : ""}${stop}`.trim(), channel: c.channel });
      return;
    }
    case "push": {
      const tokens = await prisma.pushToken.findMany({ where: { customerId: r.id }, select: { token: true } });
      if (!tokens.length) throw new Error("no push token");
      await push.send({
        tokens: tokens.map((t) => t.token), title: subject || "ASL ORIGINALS", body,
        data: { type: "campaign", campaignId: c.id, ...(token ? { token } : {}), ...(link ? { link } : {}) },
      });
      return;
    }
    case "inapp": {
      // customer inbox (support/notifications); no push — the campaign is the in-app message itself
      const n = await notify(r.id, { category: "Offers", tag: "NEW", title: subject || c.name, message: body, ctaLabel: c.ctaLabel ?? undefined, ctaLink: landing ?? undefined, inbox: true, topic: "promos" });
      if (!n.notification) throw new Error("inbox write failed");
      return;
    }
  }
}

// ── audience ──

async function audienceWhere(c: Pick<Campaign, "channel" | "segmentId">): Promise<Prisma.CustomerWhereInput> {
  const base: Prisma.CustomerWhereInput = { deletedAt: null, status: { not: "blocked" } };
  const byChannel: Record<Campaign["channel"], Prisma.CustomerWhereInput> = {
    email: { marketingOptIn: true },
    sms: { marketingOptIn: true, phone: { not: null } },
    whatsapp: { marketingOptIn: true, phone: { not: null } },
    push: { pushTokens: { some: {} } },
    inapp: {},
  };
  const parts = [base, byChannel[c.channel]];
  if (c.segmentId) parts.push(await segmentsService.customerWhere(c.segmentId));
  return { AND: parts };
}

/** still allowed to receive it at send time (opted out / blocked / deleted since the list was built → skipped) */
function stillEligible(c: Campaign, r: { deletedAt: Date | null; status: string; marketingOptIn: boolean }) {
  if (r.deletedAt || r.status === "blocked") return false;
  return c.channel === "push" || c.channel === "inapp" || r.marketingOptIn;
}

const newToken = () => crypto.randomBytes(18).toString("base64url");

async function buildRecipients(c: Campaign) {
  const where = await audienceWhere(c);
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.customer.findMany({ where, select: { id: true }, orderBy: { id: "asc" }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    await prisma.campaignRecipient.createMany({ data: rows.map((r) => ({ campaignId: c.id, customerId: r.id, token: newToken() })), skipDuplicates: true });
    if (rows.length < 1000) break;
  }
  const audienceSize = await prisma.campaignRecipient.count({ where: { campaignId: c.id } });
  await prisma.campaign.update({ where: { id: c.id }, data: { audienceSize } });
}

async function deliverBatches(id: string) {
  for (;;) {
    const c = await prisma.campaign.findUnique({ where: { id } });
    if (!c || c.status !== "sending") return false; // paused / archived mid-way
    const batch = await prisma.campaignRecipient.findMany({ where: { campaignId: id, deliveredAt: null, failedAt: null }, take: BATCH, orderBy: { id: "asc" } });
    if (!batch.length) return true;
    const customers = new Map(
      (await prisma.customer.findMany({
        where: { id: { in: batch.map((b) => b.customerId) } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, deletedAt: true, status: true, marketingOptIn: true },
      })).map((x) => [x.id, x]),
    );
    let sent = 0;
    let delivered = 0;
    for (const rec of batch) {
      // claim the row first so two dispatch runs never send twice
      const claim = await prisma.campaignRecipient.updateMany({ where: { id: rec.id, deliveredAt: null, failedAt: null }, data: { deliveredAt: new Date() } });
      if (!claim.count) continue;
      const cust = customers.get(rec.customerId);
      if (!cust || !stillEligible(c, cust)) {
        await prisma.campaignRecipient.update({ where: { id: rec.id }, data: { deliveredAt: null, failedAt: new Date() } });
        continue;
      }
      sent++;
      try {
        await sendOne(c, cust, rec.token);
        delivered++;
      } catch (err) {
        logger.warn({ err, campaignId: id, customerId: rec.customerId }, "campaign message failed");
        await prisma.campaignRecipient.update({ where: { id: rec.id }, data: { deliveredAt: null, failedAt: new Date() } });
      }
    }
    await prisma.campaign.update({ where: { id }, data: { sent: { increment: sent }, delivered: { increment: delivered } } });
  }
}

/** scheduled → sending → recipients → batches → sent. Safe to call repeatedly / concurrently. */
async function run(id: string) {
  const claimed = await prisma.campaign.updateMany({ where: { id, status: "scheduled" }, data: { status: "sending" } });
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c) return;
  if (claimed.count) {
    try {
      await buildRecipients(c);
    } catch (err) {
      logger.error({ err, campaignId: id }, "campaign audience failed (segment deleted?) — paused");
      await prisma.campaign.update({ where: { id }, data: { status: "paused" } });
      return;
    }
  } else if (c.status !== "sending") return;
  const done = await deliverBatches(id);
  if (done) await prisma.campaign.updateMany({ where: { id, status: "sending" }, data: { status: "sent", sentAt: new Date() } });
}

export const sendCampaignJob = defineJob<{ campaignId: string }>("campaigns.send", async ({ campaignId }) => run(campaignId));

// ── stats ──

type Conv = { converted: number; revenue: number };

/** paid orders by recipients within 7 days after their (first) click */
async function conversions(ids: string[] | null): Promise<Map<string, Conv>> {
  if (ids && !ids.length) return new Map();
  const filter = ids ? Prisma.sql`AND r.campaignId IN (${Prisma.join(ids)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<{ campaignId: string; n: bigint | number; revenue: unknown }[]>`
    SELECT r.campaignId AS campaignId, COUNT(o.id) AS n, COALESCE(SUM(o.total), 0) AS revenue
    FROM \`CampaignRecipient\` r
    JOIN \`Order\` o ON o.customerId = r.customerId AND o.paidAt IS NOT NULL
      AND o.paymentStatus IN ('paid', 'partially_refunded')
      AND o.paidAt >= r.clickedAt AND o.paidAt <= DATE_ADD(r.clickedAt, INTERVAL ${ATTRIBUTION_DAYS} DAY)
    WHERE r.clickedAt IS NOT NULL ${filter}
    GROUP BY r.campaignId`;
  return new Map(rows.map((r) => [r.campaignId, { converted: Number(r.n), revenue: Number(r.revenue) }]));
}

const rate = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : 0);

function toAdmin(c: Campaign, segmentName: string | null, conv?: Conv) {
  const converted = conv?.converted ?? 0;
  const revenue = conv?.revenue ?? 0;
  return {
    id: c.id, name: c.name, subject: c.subject, preheader: c.preheader ?? "", channel: c.channel, status: c.status, goal: c.goal,
    segmentId: c.segmentId, segmentName: c.segmentId ? (segmentName ?? "Deleted segment") : "All customers",
    audienceSize: c.audienceSize, scheduledAt: c.scheduledAt, sentAt: c.sentAt, createdAt: c.createdAt, updatedAt: c.updatedAt, createdBy: c.createdBy,
    sent: c.sent, delivered: c.delivered, opened: c.opened, clicked: c.clicked, converted, revenue, unsubscribed: c.unsubscribed,
    rates: { delivery: rate(c.delivered, c.sent), open: rate(c.opened, c.delivered), click: rate(c.clicked, c.delivered), conversion: rate(converted, c.clicked), unsubscribe: rate(c.unsubscribed, c.delivered) },
    body: c.body, ctaLabel: c.ctaLabel ?? "", ctaUrl: c.ctaUrl ?? "", cta: { label: c.ctaLabel ?? "", url: c.ctaUrl ?? "" },
    utm: (c.utm as Utm | null) ?? undefined, tags: (c.tags as string[] | null) ?? [], pinned: c.pinned,
  };
}

async function segmentNames(ids: (string | null)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  if (!list.length) return new Map<string, string>();
  return new Map((await prisma.segment.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
}

async function find(id: string) {
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("Campaign");
  return c;
}

async function view(c: Campaign) {
  const [names, conv] = await Promise.all([segmentNames([c.segmentId]), conversions([c.id])]);
  return toAdmin(c, c.segmentId ? (names.get(c.segmentId) ?? null) : null, conv.get(c.id));
}

async function checkSegment(segmentId: string | null | undefined) {
  if (segmentId && !(await prisma.segment.findUnique({ where: { id: segmentId }, select: { id: true } }))) throw ApiError.notFound("Segment");
}

function ensureSendable(c: Campaign) {
  if (!c.body.trim()) throw ApiError.badRequest("VALIDATION_FAILED", "Write the message before sending.");
  if ((c.channel === "email" || c.channel === "push" || c.channel === "inapp") && !c.subject.trim())
    throw ApiError.badRequest("VALIDATION_FAILED", c.channel === "email" ? "Add a subject line before sending." : "Add a title before sending.");
  if (c.ctaUrl && !safeTarget(c.ctaUrl)) throw ApiError.badRequest("VALIDATION_FAILED", "The button link must be on the ASL ORIGINALS site.");
}

function dataFrom(b: CampaignPatch): Prisma.CampaignUncheckedUpdateInput {
  const d: Prisma.CampaignUncheckedUpdateInput = {
    name: b.name, subject: b.subject, preheader: b.preheader, channel: b.channel, goal: b.goal, segmentId: b.segmentId, body: b.body,
    ctaLabel: b.cta ? b.cta.label || null : b.ctaLabel, ctaUrl: b.cta ? b.cta.url || null : b.ctaUrl,
    utm: b.utm === null ? Prisma.DbNull : b.utm, tags: b.tags, pinned: b.pinned, scheduledAt: b.scheduledAt,
  };
  if (b.ctaUrl && !safeTarget(b.ctaUrl)) throw ApiError.badRequest("VALIDATION_FAILED", "The button link must be a path (/shop) or a link on the ASL ORIGINALS site.");
  if (b.cta?.url && !safeTarget(b.cta.url)) throw ApiError.badRequest("VALIDATION_FAILED", "The button link must be a path (/shop) or a link on the ASL ORIGINALS site.");
  return d;
}

export const campaignsService = {
  async list(q: CampaignListQuery) {
    const filters: Prisma.CampaignWhereInput = {
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.segmentId ? { segmentId: q.segmentId } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { subject: { contains: q.q } }] } : {}),
    };
    const where = { ...filters, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, groups, sums, allConv] = await Promise.all([
      prisma.campaign.findMany({ where, orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }], ...paging(q) }),
      prisma.campaign.count({ where }),
      prisma.campaign.groupBy({ by: ["status"], where: filters, _count: { _all: true } }),
      prisma.campaign.aggregate({ where: filters, _sum: { sent: true, delivered: true, opened: true, clicked: true, unsubscribed: true } }),
      conversions(null),
    ]);
    const tabs: Record<string, number> = { all: 0, draft: 0, scheduled: 0, sending: 0, sent: 0, paused: 0, archived: 0 };
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    const names = await segmentNames(rows.map((r) => r.segmentId));
    const s = sums._sum;
    const delivered = s.delivered ?? 0;
    const conv = [...allConv.values()].reduce((a, x) => ({ converted: a.converted + x.converted, revenue: a.revenue + x.revenue }), { converted: 0, revenue: 0 });
    return withMeta(rows.map((c) => toAdmin(c, c.segmentId ? (names.get(c.segmentId) ?? null) : null, allConv.get(c.id))), {
      ...pageMeta(q, total), tabs,
      kpis: { sent: s.sent ?? 0, delivered, opened: s.opened ?? 0, clicked: s.clicked ?? 0, unsubscribed: s.unsubscribed ?? 0,
        openRate: rate(s.opened ?? 0, delivered), clickRate: rate(s.clicked ?? 0, delivered), ...conv },
    });
  },

  async get(id: string) {
    return view(await find(id));
  },

  async create(b: CampaignBody, admin: { name: string }) {
    await checkSegment(b.segmentId);
    const d = dataFrom(b) as Prisma.CampaignUncheckedCreateInput;
    const c = await prisma.campaign.create({ data: { ...d, name: b.name, subject: b.subject, channel: b.channel, body: b.body, status: "draft", createdBy: admin.name } });
    return view(c);
  },

  async update(id: string, b: CampaignPatch) {
    const c = await find(id);
    if (!EDITABLE.includes(c.status) || (c.status === "paused" && c.audienceSize > 0))
      throw ApiError.badRequest("INVALID_STATE", "Only drafts, scheduled and paused (not yet sending) campaigns can be edited.");
    if (b.segmentId !== undefined) await checkSegment(b.segmentId);
    const before = await view(c);
    const after = await view(await prisma.campaign.update({ where: { id }, data: dataFrom(b) }));
    return { before, after };
  },

  async duplicate(id: string, admin: { name: string }) {
    const c = await find(id);
    const copy = await prisma.campaign.create({
      data: {
        name: `${c.name} (copy)`, subject: c.subject, preheader: c.preheader, channel: c.channel, goal: c.goal, segmentId: c.segmentId, body: c.body,
        ctaLabel: c.ctaLabel, ctaUrl: c.ctaUrl, utm: c.utm ?? Prisma.DbNull, tags: c.tags ?? [], status: "draft", createdBy: admin.name,
      },
    });
    return view(copy);
  },

  async togglePin(id: string) {
    const c = await find(id);
    return view(await prisma.campaign.update({ where: { id }, data: { pinned: !c.pinned } }));
  },

  async remove(id: string) {
    const c = await find(id);
    if (c.status === "sending") throw ApiError.badRequest("INVALID_STATE", "Pause the campaign before deleting it.");
    await prisma.campaign.delete({ where: { id } });
    return { deleted: true, name: c.name };
  },

  async setStatus(id: string, b: CampaignStatusBody) {
    const c = await find(id);
    const from = c.status;
    const fail = (msg: string) => ApiError.badRequest("INVALID_STATE", msg);
    let data: Prisma.CampaignUpdateInput;
    let kick = false;
    switch (b.action) {
      case "schedule": {
        if (from !== "draft" && !(from === "paused" && c.audienceSize === 0)) throw fail("Only drafts can be scheduled.");
        const at = b.scheduledAt ?? c.scheduledAt;
        if (!at) throw ApiError.badRequest("VALIDATION_FAILED", "Pick a send time.");
        ensureSendable(c);
        await checkSegment(c.segmentId);
        data = { status: "scheduled", scheduledAt: at };
        break;
      }
      case "unschedule":
        if (from !== "scheduled") throw fail("Only scheduled campaigns can be moved back to draft.");
        data = { status: "draft" };
        break;
      case "pause":
        if (from !== "scheduled" && from !== "sending") throw fail("Only scheduled or sending campaigns can be paused.");
        data = { status: "paused" };
        break;
      case "resume":
        if (from !== "paused") throw fail("Only paused campaigns can be resumed.");
        if (c.audienceSize > 0) {
          data = { status: "sending" };
          kick = true;
        } else {
          ensureSendable(c);
          data = { status: "scheduled", scheduledAt: b.scheduledAt ?? c.scheduledAt ?? new Date() };
        }
        break;
      case "archive":
        if (from === "sending") throw fail("Pause the campaign before archiving it.");
        data = { status: "archived" };
        break;
      case "unarchive":
        if (from !== "archived") throw fail("This campaign isn't archived.");
        data = { status: c.sentAt ? "sent" : "draft" };
        break;
    }
    const after = await prisma.campaign.update({ where: { id }, data });
    if (kick) await sendCampaignJob({ campaignId: id });
    return { from, after: await view(after) };
  },

  /** send immediately (draft / scheduled / paused-before-sending); the job builds the audience and sends in batches */
  async sendNow(id: string) {
    const c = await find(id);
    if (c.status === "paused" && c.audienceSize > 0) return (await this.setStatus(id, { action: "resume" })).after;
    if (!["draft", "scheduled", "paused"].includes(c.status)) throw ApiError.badRequest("INVALID_STATE", `This campaign is ${c.status}.`);
    ensureSendable(c);
    await checkSegment(c.segmentId);
    await prisma.campaign.update({ where: { id }, data: { status: "scheduled", scheduledAt: new Date() } });
    await sendCampaignJob({ campaignId: id });
    return view(await find(id));
  },

  /** one message to the admin (email) / a phone (SMS) / a device (push) / a customer's inbox (in-app); not counted in stats */
  async sendTest(id: string, b: SendTestBody, admin: { email: string; name: string }) {
    const c = await find(id);
    if (!c.body.trim()) throw ApiError.badRequest("VALIDATION_FAILED", "Write the message before sending a test.");
    const test = { ...c, subject: `[Test] ${c.subject || c.name}` };
    const [firstName, ...rest] = admin.name.split(" ");
    if (c.channel === "email") {
      const to = b.to ?? admin.email;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw ApiError.badRequest("VALIDATION_FAILED", "Enter a valid email address.");
      await sendOne(test, { id: "test", firstName, lastName: rest.join(" "), email: to, phone: null }, null);
      return { sent: true, channel: c.channel, to };
    }
    if (c.channel === "sms" || c.channel === "whatsapp") {
      if (!b.to || !/^\+?[0-9 ()-]{7,20}$/.test(b.to)) throw ApiError.badRequest("VALIDATION_FAILED", "Enter the phone number to send the test to.");
      await sendOne(test, { id: "test", firstName, lastName: rest.join(" "), email: admin.email, phone: b.to }, null);
      return { sent: true, channel: c.channel, to: b.to };
    }
    if (c.channel === "push") {
      const token = b.token ?? `test-device:${admin.email}`;
      const link = landingUrl(c);
      await push.send({ tokens: [token], title: fill(test.subject, { firstName }), body: fill(c.body, { firstName }), data: { type: "campaign", test: "true", ...(link ? { link } : {}) } });
      return { sent: true, channel: c.channel, to: token };
    }
    if (!b.customerId) throw ApiError.badRequest("VALIDATION_FAILED", "Choose the customer whose inbox gets the test.");
    const cust = await prisma.customer.findFirst({ where: { id: b.customerId, deletedAt: null }, select: { id: true, firstName: true, lastName: true, email: true, phone: true } });
    if (!cust) throw ApiError.notFound("Customer");
    await sendOne(test, cust, null);
    return { sent: true, channel: c.channel, to: cust.email };
  },

  /** customers who would get it if sent now */
  async audience(id: string) {
    const c = await find(id);
    await checkSegment(c.segmentId);
    return { audienceSize: await prisma.customer.count({ where: await audienceWhere(c) }) };
  },

  /** due scheduled campaigns + ones left in `sending` (resumed, or a worker stopped mid-way) */
  async dispatchDue(now = new Date()) {
    const due = await prisma.campaign.findMany({
      where: { OR: [{ status: "scheduled", scheduledAt: { lte: now } }, { status: "sending" }] }, select: { id: true }, orderBy: { scheduledAt: "asc" },
    });
    for (const d of due) await run(d.id);
    return due.length;
  },

  // ── public tracking ──

  async trackOpen(token: string) {
    const r = await prisma.campaignRecipient.findUnique({ where: { token }, select: { id: true, campaignId: true, openedAt: true } });
    if (!r || r.openedAt) return;
    const n = await prisma.campaignRecipient.updateMany({ where: { id: r.id, openedAt: null }, data: { openedAt: new Date() } });
    if (n.count) await prisma.campaign.update({ where: { id: r.campaignId }, data: { opened: { increment: 1 } } });
  },

  /** → URL to redirect to, or null when `u` points off-site (open-redirect guard) */
  async trackClick(token: string, u: string | undefined) {
    const target = u ? safeTarget(u) : `${web}/`;
    if (!target) return null;
    const r = await prisma.campaignRecipient.findUnique({ where: { token }, select: { id: true, campaignId: true, clickedAt: true, openedAt: true } });
    if (r && !r.clickedAt) {
      const now = new Date();
      const n = await prisma.campaignRecipient.updateMany({ where: { id: r.id, clickedAt: null }, data: { clickedAt: now } });
      if (n.count) {
        // a click proves the message was opened (images may be blocked)
        const opened = r.openedAt ? 0 : (await prisma.campaignRecipient.updateMany({ where: { id: r.id, openedAt: null }, data: { openedAt: now } })).count;
        await prisma.campaign.update({ where: { id: r.campaignId }, data: { clicked: { increment: 1 }, opened: { increment: opened } } });
      }
    }
    return target;
  },

  /** → the email that was unsubscribed, or null for an unknown link */
  async unsubscribe(token: string) {
    const r = await prisma.campaignRecipient.findUnique({ where: { token }, select: { campaignId: true, customerId: true } });
    if (!r) return null;
    const cust = await prisma.customer.findUnique({ where: { id: r.customerId }, select: { email: true, deletedAt: true } });
    if (!cust || cust.deletedAt) return null;
    const n = await prisma.customer.updateMany({ where: { id: r.customerId, marketingOptIn: true }, data: { marketingOptIn: false } });
    if (n.count) await prisma.campaign.update({ where: { id: r.campaignId }, data: { unsubscribed: { increment: 1 } } });
    return { email: cust.email };
  },
};

export const dispatchCampaignsJob = defineJob("campaigns.dispatch", async () => void (await campaignsService.dispatchDue()));
