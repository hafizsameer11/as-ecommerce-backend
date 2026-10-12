/**
 * asl-admin /messaging → Templates: every system email / SMS / push is rendered from these rows
 * (`messaging.render` reads the row; paused / draft rows are not sent; missing rows fall back to templates.defaults.ts).
 */
import type { MessageTemplate, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { env } from "@/config/env";
import { mail } from "@/providers/mail/mail";
import { sms } from "@/providers/sms/sms";
import { push } from "@/providers/push/push";
import { DEFAULT_TEMPLATES } from "./templates.defaults";
import { fill, messaging, templateVariables, type Vars } from "./messaging.service";
import type { PreviewBody, TemplateListQuery, TemplatePatch, TestSendBody } from "./messaging.schemas";

const web = env.WEB_URL.replace(/\/$/, "");

/** realistic values for the {{variables}} the backend sends (preview + test sends) */
export const SAMPLE_VARS: Record<string, string> = {
  firstName: "Ada", lastName: "Okafor", name: "Ada Okafor", email: "ada@example.com",
  code: "482913", resetUrl: `${web}/auth?mode=reset&token=sample`, inviteUrl: `${env.APP_URL}/admin/invite?token=sample`,
  inviter: "Amaka O.", role: "Marketing",
  orderNumber: "ASL-10234", total: "₦245,000", orderUrl: `${web}/account/orders/ASL-10234`, carrier: "GIG Logistics", tracking: "GIG123456789",
  location: "ASL Lekki Flagship", address: "12 Admiralty Way, Lekki", hours: "Mon–Sat 10:00–19:00", reason: "Payment was not completed in time.",
  returnNumber: "RET-1042", status: "Approved", note: "We'll collect the item tomorrow.",
  requestNumber: "CR-2051", itemName: "Rolex Daytona 116500LN", expiresAt: "20 Oct 2026", deposit: "₦1,250,000", requestUrl: `${web}/track-request?id=CR-2051`,
  agent: "Tunde A.", text: "We found two pieces in your size.",
  ticketNumber: "TCK-3310", subject: "Where is my order?", body: "Your parcel left our warehouse this morning.",
  amount: "₦50,000", invoiceNumber: "INV-10234", draftNumber: "DFT-1007", payUrl: `${web}/pay/sample`,
  items: "Air Jordan 1 High OG, Dior Sauvage", recoverUrl: `${web}/cart`,
  tier: "Gold", url: `${web}/account/benefits`, advocate: "Chidera E.", reward: "10% off your first order", friend: "Kemi A.",
  productName: "Travis Scott x Jordan 1 Low", reservationNumber: "RSV-1201", sizeText: " (UK 9)", releaseDate: "25 Oct 2026",
  balance: "₦480,000", reservationUrl: `${web}/account/orders?reservation=RSV-1201`, dueBy: "28 Oct 2026",
  depositPolicy: "If the balance isn't paid in time the deposit is kept.", depositText: "Your deposit has been returned to your ASL Wallet.",
};

const sampleFor = (names: string[], over: Vars = {}): Vars =>
  Object.fromEntries(names.map((n) => [n, over[n] ?? SAMPLE_VARS[n] ?? `[${n}]`]));

const varsOf = (t: Pick<MessageTemplate, "subject" | "preheader" | "body" | "linkTo">) => templateVariables(t.subject, t.preheader, t.body, t.linkTo);

const toAdmin = (t: MessageTemplate) => ({
  id: t.id, code: t.code, name: t.name, channel: t.channel, category: t.category, status: t.status, trigger: t.trigger,
  subject: t.subject ?? "", preheader: t.preheader ?? "", body: t.body, cta: t.ctaLabel ?? "", ctaLabel: t.ctaLabel ?? "", linkTo: t.linkTo ?? "",
  variables: (t.variables as string[] | null) ?? varsOf(t),
  sentCount: t.sentCount,
  // open / click / bounce tracking is only built for campaigns; transactional sends are counted, not tracked
  sentLast30: t.sentCount, openRate: null, clickRate: null, bounceRate: null,
  hasDefault: DEFAULT_TEMPLATES.some((d) => d.code === t.code && d.channel === t.channel),
  notes: t.notes ?? "", createdAt: t.createdAt, updatedAt: t.updatedAt,
});

async function find(id: string) {
  const t = await prisma.messageTemplate.findUnique({ where: { id } });
  if (!t) throw ApiError.notFound("Template");
  return t;
}

/** DB rows are created from the defaults if a code is missing (fresh DBs, codes added after seeding) */
async function syncDefaults() {
  const have = new Set((await prisma.messageTemplate.findMany({ select: { code: true, channel: true } })).map((t) => `${t.code}|${t.channel}`));
  const missing = DEFAULT_TEMPLATES.filter((d) => !have.has(`${d.code}|${d.channel}`));
  if (!missing.length) return;
  await prisma.messageTemplate.createMany({
    data: missing.map((d) => ({
      code: d.code, name: d.name, channel: d.channel, category: d.category, trigger: d.trigger, subject: d.subject, body: d.body,
      ctaLabel: d.ctaLabel, linkTo: d.linkTo, variables: templateVariables(d.subject, d.body, d.linkTo),
    })),
    skipDuplicates: true,
  });
}

function rendered(t: Pick<MessageTemplate, "subject" | "preheader" | "body" | "ctaLabel" | "linkTo">, vars: Vars) {
  const link = t.linkTo ? fill(t.linkTo, vars) : "";
  return {
    subject: fill(t.subject ?? "", vars),
    preheader: fill(t.preheader ?? "", vars),
    body: fill(t.body, vars),
    ctaLabel: t.ctaLabel ?? "",
    // relative links in templates open on the storefront
    link: link.startsWith("/") ? `${web}${link}` : link,
  };
}

export const templatesService = {
  async list(q: TemplateListQuery) {
    await syncDefaults();
    const filters: Prisma.MessageTemplateWhereInput = {
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { code: { contains: q.q } }, { subject: { contains: q.q } }] } : {}),
    };
    const where = { ...filters, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, groups, sent] = await Promise.all([
      prisma.messageTemplate.findMany({ where, orderBy: [{ category: "asc" }, { code: "asc" }, { channel: "asc" }], ...paging(q) }),
      prisma.messageTemplate.count({ where }),
      prisma.messageTemplate.groupBy({ by: ["status"], where: filters, _count: { _all: true } }),
      prisma.messageTemplate.aggregate({ where: filters, _sum: { sentCount: true } }),
    ]);
    const tabs: Record<string, number> = { all: 0, active: 0, draft: 0, paused: 0 };
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    return withMeta(rows.map(toAdmin), { ...pageMeta(q, total), tabs, kpis: { templates: tabs.all, active: tabs.active, sent: sent._sum.sentCount ?? 0 } });
  },

  async get(id: string) {
    return toAdmin(await find(id));
  },

  async update(id: string, p: TemplatePatch) {
    const before = toAdmin(await find(id));
    const ctaLabel = p.ctaLabel !== undefined ? p.ctaLabel : p.cta;
    const data: Prisma.MessageTemplateUpdateInput = {
      name: p.name, subject: p.subject, preheader: p.preheader, body: p.body, ctaLabel, linkTo: p.linkTo, status: p.status, trigger: p.trigger, notes: p.notes,
    };
    const next = { subject: p.subject !== undefined ? p.subject : before.subject, preheader: p.preheader !== undefined ? p.preheader : before.preheader,
      body: p.body ?? before.body, linkTo: p.linkTo !== undefined ? p.linkTo : before.linkTo };
    data.variables = templateVariables(next.subject, next.preheader, next.body, next.linkTo);
    const after = toAdmin(await prisma.messageTemplate.update({ where: { id }, data }));
    return { before, after };
  },

  async setStatus(id: string, status: MessageTemplate["status"]) {
    await find(id);
    return toAdmin(await prisma.messageTemplate.update({ where: { id }, data: { status } }));
  },

  /** copy as a draft under a new code (`order.confirmed.copy`) — copies are never sent by the system until wired to a trigger */
  async duplicate(id: string) {
    const t = await find(id);
    let code = `${t.code}.copy`;
    for (let i = 2; await prisma.messageTemplate.findUnique({ where: { code_channel: { code, channel: t.channel } } }); i++) code = `${t.code}.copy${i}`;
    const { id: _id, createdAt: _c, updatedAt: _u, sentCount: _s, ...rest } = t;
    return toAdmin(await prisma.messageTemplate.create({ data: { ...rest, code, name: `${t.name} (copy)`, status: "draft", variables: varsOf(t) } }));
  },

  /** delete a copy; built-in templates can only be paused or reset */
  async remove(id: string) {
    const t = await find(id);
    if (DEFAULT_TEMPLATES.some((d) => d.code === t.code && d.channel === t.channel))
      throw ApiError.badRequest("INVALID_STATE", "Built-in templates can't be deleted. Pause it instead.");
    await prisma.messageTemplate.delete({ where: { id } });
    return { deleted: true, code: t.code };
  },

  /** back to the text shipped with the backend (status → active) */
  async reset(id: string) {
    const t = await find(id);
    const d = DEFAULT_TEMPLATES.find((x) => x.code === t.code && x.channel === t.channel);
    if (!d) throw ApiError.badRequest("INVALID_STATE", "This template has no built-in default (it's a copy).");
    const before = toAdmin(t);
    const after = toAdmin(
      await prisma.messageTemplate.update({
        where: { id },
        data: { name: d.name, category: d.category, trigger: d.trigger, subject: d.subject ?? null, preheader: null, body: d.body,
          ctaLabel: d.ctaLabel ?? null, linkTo: d.linkTo ?? null, status: "active", variables: templateVariables(d.subject, d.body, d.linkTo) },
      }),
    );
    return { before, after };
  },

  /** render with sample data (or unsaved edits in `draft`) */
  async preview(id: string, b: PreviewBody) {
    const t = await find(id);
    const d = b.draft ?? {};
    const src = {
      subject: d.subject !== undefined ? d.subject : t.subject,
      preheader: d.preheader !== undefined ? d.preheader : t.preheader,
      body: d.body ?? t.body,
      ctaLabel: d.ctaLabel !== undefined ? d.ctaLabel : d.cta !== undefined ? d.cta : t.ctaLabel,
      linkTo: d.linkTo !== undefined ? d.linkTo : t.linkTo,
    };
    const variables = varsOf(src);
    const vars = sampleFor(variables, b.vars);
    const r = rendered(src, vars);
    const html = t.channel === "email" ? await messaging.emailHtml(r.subject, r.body, r.ctaLabel || undefined, r.link || undefined, { preheader: r.preheader || undefined }) : null;
    return { channel: t.channel, status: t.status, variables, vars, ...r, html };
  },

  /** send this template (any status, so drafts can be checked) to the admin / a test number / a test device */
  async test(id: string, b: TestSendBody, admin: { email: string; name: string }) {
    const t = await find(id);
    const vars = sampleFor(varsOf(t), { firstName: admin.name.split(" ")[0], name: admin.name, email: admin.email, ...b.vars });
    const r = rendered(t, vars);
    const subject = `[Test] ${r.subject || t.name}`;
    if (t.channel === "email") {
      const to = b.to ?? admin.email;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw ApiError.badRequest("VALIDATION_FAILED", "Enter a valid email address.");
      await mail.send({ to, subject, text: r.body, html: await messaging.emailHtml(subject, r.body, r.ctaLabel || undefined, r.link || undefined, { preheader: r.preheader || undefined }) });
      return { sent: true, channel: t.channel, to, subject };
    }
    if (t.channel === "sms" || t.channel === "whatsapp") {
      if (!b.to || !/^\+?[0-9 ()-]{7,20}$/.test(b.to)) throw ApiError.badRequest("VALIDATION_FAILED", "Enter the phone number to send the test to.");
      await sms.send({ to: b.to, body: r.body, channel: t.channel });
      return { sent: true, channel: t.channel, to: b.to, body: r.body };
    }
    const token = b.token ?? `test-device:${admin.email}`;
    await push.send({ tokens: [token], title: r.subject || "ASL ORIGINALS", body: r.body, data: { test: "true", templateId: t.id } });
    return { sent: true, channel: t.channel, to: token, title: r.subject, body: r.body };
  },
};
