import type { Prisma, Ticket, TicketMessage } from "@/generated/prisma/client";
import type { TicketCategory, TicketChannel, TicketPriority, TicketStatus } from "@/generated/prisma/enums";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { realtime } from "@/core/realtime/realtime";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { effectivePermissions } from "@/modules/identity/team/team.permissions";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { notifyStaff } from "@/modules/platform/notification-settings/notification-settings.service";
import { ACTIVE_STATUSES, CLOSED_STATUSES, guessCategory, toAdminTicket, toCustomerTicket } from "./tickets.mapper";
import type {
  AdminTicketsQuery, ContactBody, CreateTicketBody, MyTicketsQuery, ReplyBody, TicketPatch,
} from "./tickets.schemas";

type Actor = { id: string; name: string };
type Attachment = { name: string; kind: "image" | "file"; url: string };

const full = { messages: { orderBy: { createdAt: "asc" } } } satisfies Prisma.TicketInclude;

/** ticket id, "#5201" or "5201" */
const key = (id: string): Prisma.TicketWhereInput => {
  const n = id.trim().replace(/^#/, "");
  return /^\d+$/.test(n) ? { OR: [{ id }, { number: `#${n}` }] } : { id };
};

/** socket: public messages to the ticket room + the customer + support staff; internal notes to staff only */
function broadcast(t: { id: string; number: string; customerId: string | null }, m: TicketMessage) {
  const message = {
    id: m.id, author: m.author, authorName: m.author === "system" && !m.internal ? "ASL ORIGINALS" : m.authorName, body: m.body, internal: m.internal,
    attachments: (m.attachments as Attachment[] | null) ?? [], at: m.createdAt,
  };
  const rooms = m.internal
    ? [`ticket:${t.id}:staff`, "admin:perm:support.tickets"]
    : [`ticket:${t.id}`, "admin:perm:support.tickets", ...(t.customerId ? [`customer:${t.customerId}`] : [])];
  realtime.emit(rooms, "ticket.message", { ticketId: t.id, number: t.number, message });
}

async function uploads(files: UploadInput[], by: string): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files.slice(0, 5)) {
    const m = await mediaService.upload(f, "support", by);
    out.push({ name: f.originalname.slice(0, 190), kind: f.mimetype.startsWith("image/") ? "image" : "file", url: (m.variants as Record<string, string> | null)?.lg ?? m.url });
  }
  return out;
}

async function slaDue(from: Date, priority: TicketPriority) {
  const cfg = await settingsService.get("support");
  return new Date(from.getTime() + cfg.firstResponseHours[priority] * 3_600_000);
}

async function adminNames(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await prisma.adminUser.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function open(input: {
  subject: string; body: string; category: TicketCategory; channel: TicketChannel; customerId: string | null;
  customerName: string; customerEmail: string; orderRef?: string; priority?: TicketPriority; attachments: Attachment[];
}) {
  const cfg = await settingsService.get("support");
  const priority = input.priority ?? cfg.defaultPriority;
  const now = new Date();
  const due = await slaDue(now, priority);
  const t = await prisma.$transaction(async (tx: Tx) => {
    const n = await nextSequence(tx, "ticket", 5201);
    return tx.ticket.create({
      data: {
        number: formatters.ticket(n), subject: input.subject, category: input.category, channel: input.channel, priority,
        customerId: input.customerId, customerName: input.customerName, customerEmail: input.customerEmail, orderRef: input.orderRef || null,
        customerCreated: true, createdAt: now, slaDueAt: due, tags: [],
        messages: { create: { author: "customer", authorName: input.customerName, body: input.body, attachments: input.attachments.length ? input.attachments : undefined } },
      },
      include: full,
    });
  });
  events.emit("ticket.created", { ticketId: t.id });
  return t;
}

async function findMine(customerId: string, id: string) {
  const t = await prisma.ticket.findFirst({ where: { AND: [key(id), { customerId }] }, include: full });
  if (!t) throw ApiError.notFound("Ticket");
  return t;
}

async function findAny(id: string) {
  const t = await prisma.ticket.findFirst({ where: key(id), include: full });
  if (!t) throw ApiError.notFound("Ticket");
  return t;
}

function adminWhere(q: AdminTicketsQuery, adminId: string): Prisma.TicketWhereInput {
  const and: Prisma.TicketWhereInput[] = [];
  if (q.status) and.push({ status: q.status });
  if (q.priority) and.push({ priority: q.priority });
  if (q.channel) and.push({ channel: q.channel });
  if (q.category) and.push({ category: q.category });
  if (q.assignee) and.push({ assigneeId: q.assignee === "none" ? null : q.assignee === "me" ? adminId : q.assignee });
  if (q.tag) and.push({ tags: { array_contains: q.tag.toLowerCase() } });
  if (q.q) {
    const s = q.q.trim();
    and.push({ OR: [{ number: { contains: s } }, { subject: { contains: s } }, { customerName: { contains: s } }, { customerEmail: { contains: s } }, { orderRef: { contains: s } }, { messages: { some: { body: { contains: s } } } }] });
  }
  return { AND: and };
}

function tabWhere(tab: AdminTicketsQuery["tab"], adminId: string, now: Date): Prisma.TicketWhereInput {
  switch (tab) {
    case "all": return {};
    case "unassigned": return { assigneeId: null, status: { in: ACTIVE_STATUSES } };
    case "mine": return { assigneeId: adminId, status: { in: ACTIVE_STATUSES } };
    case "breached": return { status: { in: ACTIVE_STATUSES }, firstResponseAt: null, slaDueAt: { lt: now } };
    default: return { status: tab };
  }
}

function toTags(t: Ticket) {
  return (t.tags as string[] | null) ?? [];
}

export const ticketsService = {
  // ── customer ──
  /** /account/help/contact (signed in) */
  async create(customerId: string, b: CreateTicketBody, files: UploadInput[]) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { firstName: true, lastName: true, email: true, tier: true } });
    const atts = await uploads(files, `customer:${customerId}`);
    const t = await open({
      subject: b.topic, body: b.message, category: b.category ?? guessCategory(b.topic), channel: b.channel, customerId,
      customerName: fullName(c) || c.email, customerEmail: c.email, orderRef: b.orderRef,
      // Signature members get a faster first response
      priority: c.tier === "Signature" ? "high" : undefined, attachments: atts,
    });
    return { ...toCustomerTicket(t), reference: t.number, message: "Request Received" };
  },

  /** /customer-care/contact-us (guest; linked to the account when signed in) */
  async contact(b: ContactBody, customerId?: string) {
    const t = await open({
      subject: b.subject, body: b.phone ? `${b.message}\n\nPhone: ${b.phone}` : b.message, category: guessCategory(b.subject), channel: "email",
      customerId: customerId ?? null, customerName: b.name, customerEmail: b.email, orderRef: b.orderRef, attachments: [],
    });
    return { id: t.id, number: t.number, reference: t.number, subject: t.subject, status: "Open", createdAt: t.createdAt, message: "Message sent" };
  },

  async myList(customerId: string, q: MyTicketsQuery) {
    const base: Prisma.TicketWhereInput = { customerId };
    const where: Prisma.TicketWhereInput = {
      ...base,
      status: q.tab === "open" ? { in: ACTIVE_STATUSES } : q.tab === "closed" ? { in: CLOSED_STATUSES } : undefined,
      OR: q.q ? [{ subject: { contains: q.q } }, { number: { contains: q.q } }] : undefined,
    };
    const [rows, total, groups] = await Promise.all([
      prisma.ticket.findMany({
        where, orderBy: { updatedAt: "desc" }, ...paging(q),
        include: { messages: { where: { internal: false }, orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: { where: { internal: false } } } } },
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    ]);
    const count = (s: TicketStatus[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    return withMeta(rows.map((t) => toCustomerTicket(t, false)), {
      ...pageMeta(q, total), tabs: { all: count([...ACTIVE_STATUSES, ...CLOSED_STATUSES]), open: count(ACTIVE_STATUSES), closed: count(CLOSED_STATUSES) },
    });
  },

  async myGet(customerId: string, id: string) {
    return toCustomerTicket(await findMine(customerId, id));
  },

  async customerMessage(customerId: string, id: string, body: string, files: UploadInput[]) {
    const t = await findMine(customerId, id);
    if (t.status === "closed") throw ApiError.conflict("INVALID_STATE", "This ticket is closed. Please start a new one.");
    const atts = await uploads(files, `customer:${customerId}`);
    const msg = await prisma.$transaction(async (tx) => {
      const m = await tx.ticketMessage.create({ data: { ticketId: t.id, author: "customer", authorName: t.customerName, body, attachments: atts.length ? atts : undefined } });
      // the customer answered → back in the team's queue
      await tx.ticket.update({ where: { id: t.id }, data: { status: "open", resolvedAt: null } });
      return m;
    });
    events.emit("ticket.replied", { ticketId: t.id, by: "customer" });
    broadcast(t, msg);
    return this.myGet(customerId, t.id);
  },

  async reopen(customerId: string, id: string) {
    const t = await findMine(customerId, id);
    if (!CLOSED_STATUSES.includes(t.status)) throw ApiError.conflict("INVALID_STATE", "This ticket is still open.");
    const msg = await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: t.id }, data: { status: "open", resolvedAt: null } });
      return tx.ticketMessage.create({ data: { ticketId: t.id, author: "system", authorName: "System", body: "Ticket reopened by the customer." } });
    });
    events.emit("ticket.replied", { ticketId: t.id, by: "customer" });
    broadcast(t, msg);
    return this.myGet(customerId, t.id);
  },

  // ── admin /tickets ──
  async adminList(q: AdminTicketsQuery, adminId: string) {
    const now = new Date();
    const base = adminWhere(q, adminId);
    const where: Prisma.TicketWhereInput = { AND: [base, tabWhere(q.tab, adminId, now)] };
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const [rows, total, groups, unassigned, mine, breached, responded] = await Promise.all([
      prisma.ticket.findMany({
        where, ...paging(q),
        orderBy: q.sort === "sla" ? [{ slaDueAt: "asc" }] : q.sort === "createdAt" ? [{ createdAt: "asc" }] : q.sort === "-createdAt" ? [{ createdAt: "desc" }] : [{ updatedAt: "desc" }],
        include: { messages: { orderBy: { createdAt: "desc" }, take: 1 }, _count: { select: { messages: true } } },
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      prisma.ticket.count({ where: { AND: [base, tabWhere("unassigned", adminId, now)] } }),
      prisma.ticket.count({ where: { AND: [base, tabWhere("mine", adminId, now)] } }),
      prisma.ticket.count({ where: { AND: [base, tabWhere("breached", adminId, now)] } }),
      prisma.ticket.findMany({ where: { firstResponseAt: { not: null }, createdAt: { gte: since } }, select: { createdAt: true, firstResponseAt: true, slaDueAt: true } }),
    ]);
    const names = await adminNames(rows.map((r) => r.assigneeId));
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<TicketStatus, number>>;
    const tabs = {
      all: groups.reduce((n, g) => n + g._count._all, 0),
      open: byStatus.open ?? 0, pending: byStatus.pending ?? 0, on_hold: byStatus.on_hold ?? 0, resolved: byStatus.resolved ?? 0, closed: byStatus.closed ?? 0,
      unassigned, mine, breached,
    };
    const avgMs = responded.length ? responded.reduce((n, r) => n + (r.firstResponseAt!.getTime() - r.createdAt.getTime()), 0) / responded.length : null;
    const metSla = responded.filter((r) => r.slaDueAt && r.firstResponseAt! <= r.slaDueAt).length;
    const kpis = {
      open: tabs.open,
      awaitingCustomer: tabs.pending,
      unassigned,
      slaBreached: breached,
      avgFirstResponseMinutes: avgMs === null ? null : Math.round(avgMs / 60_000),
      slaMetPct: responded.length ? Math.round((metSla / responded.length) * 100) : null,
    };
    return withMeta(rows.map((t) => toAdminTicket(t, names)), { ...pageMeta(q, total), tabs, kpis });
  },

  async adminGet(id: string) {
    const t = await findAny(id);
    const names = await adminNames([t.assigneeId]);
    const other = t.customerId
      ? await prisma.ticket.findMany({ where: { customerId: t.customerId, id: { not: t.id } }, select: { id: true, number: true, subject: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 10 })
      : [];
    return { ...toAdminTicket(t, names, true), otherTickets: other };
  },

  async reply(id: string, b: ReplyBody, files: UploadInput[], actor: Actor) {
    const t = await findAny(id);
    const atts = await uploads(files, `admin:${actor.id}`);
    const now = new Date();
    const msg = await prisma.$transaction(async (tx) => {
      const m = await tx.ticketMessage.create({ data: { ticketId: t.id, author: "agent", authorName: actor.name, body: b.body, internal: b.internal, attachments: atts.length ? atts : undefined } });
      if (b.internal) {
        await tx.ticket.update({ where: { id: t.id }, data: { updatedAt: now } });
        return m;
      }
      await tx.ticket.update({
        where: { id: t.id },
        data: {
          firstResponseAt: t.firstResponseAt ?? now,
          // answered → waiting on the customer (on hold / resolved stay as they are)
          status: t.status === "open" ? "pending" : t.status,
          // first agent to answer an unassigned ticket picks it up
          assigneeId: t.assigneeId ?? actor.id,
        },
      });
      return m;
    });
    if (!b.internal) events.emit("ticket.replied", { ticketId: t.id, by: "agent" });
    broadcast(t, msg);
    return this.adminGet(t.id);
  },

  async update(id: string, b: TicketPatch, actor: Actor) {
    const t = await findAny(id);
    const before = { status: t.status, priority: t.priority, category: t.category };
    const data: Prisma.TicketUpdateInput = {};
    if (b.status && b.status !== t.status) {
      data.status = b.status;
      data.resolvedAt = CLOSED_STATUSES.includes(b.status) ? (t.resolvedAt ?? new Date()) : null;
    }
    if (b.priority && b.priority !== t.priority) {
      data.priority = b.priority;
      // SLA follows the new priority until the first response
      if (!t.firstResponseAt) data.slaDueAt = await slaDue(t.createdAt, b.priority);
    }
    if (b.category) data.category = b.category;
    if (Object.keys(data).length) {
      await prisma.$transaction(async (tx) => {
        await tx.ticket.update({ where: { id: t.id }, data });
        const changes = [
          data.status ? `status ${t.status} → ${b.status}` : null,
          data.priority ? `priority ${t.priority} → ${b.priority}` : null,
        ].filter(Boolean);
        if (changes.length) await tx.ticketMessage.create({ data: { ticketId: t.id, author: "system", authorName: "System", internal: true, body: `${actor.name} changed ${changes.join(", ")}.` } });
      });
    }
    const after = await this.adminGet(t.id);
    return { before, after };
  },

  async assign(id: string, adminId: string | null, actor: Actor) {
    const t = await findAny(id);
    let name: string | null = null;
    if (adminId) {
      const a = await prisma.adminUser.findUnique({ where: { id: adminId } });
      if (!a || a.status !== "active") throw ApiError.badRequest("VALIDATION_FAILED", "Choose an active team member.");
      if (!(await effectivePermissions(a.role)).has("support.tickets")) throw ApiError.badRequest("VALIDATION_FAILED", `${a.name} can't work on support tickets (role ${a.role}).`);
      name = a.name;
    }
    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id: t.id }, data: { assigneeId: adminId } });
      await tx.ticketMessage.create({ data: { ticketId: t.id, author: "system", authorName: "System", internal: true, body: name ? `${actor.name} assigned the ticket to ${name}.` : `${actor.name} unassigned the ticket.` } });
    });
    if (adminId && adminId !== actor.id)
      await prisma.adminNotification.create({
        data: { adminId, ruleId: null, title: `Ticket ${t.number} assigned to you`, body: `${actor.name} assigned "${t.subject}" to you.`, link: `/tickets?id=${t.id}`, priority: t.priority === "urgent" ? "high" : "normal" },
      }).then((n) => realtime.bell(n)).catch((err) => logger.error({ err }, "ticket assignment notification failed"));
    return this.adminGet(t.id);
  },

  async addTag(id: string, tag: string) {
    const t = await findAny(id);
    const tags = toTags(t);
    if (!tags.includes(tag)) await prisma.ticket.update({ where: { id: t.id }, data: { tags: [...tags, tag] } });
    return this.adminGet(t.id);
  },

  async removeTag(id: string, tag: string) {
    const t = await findAny(id);
    const tags = toTags(t);
    const lower = tag.toLowerCase();
    if (tags.includes(lower)) await prisma.ticket.update({ where: { id: t.id }, data: { tags: tags.filter((x) => x !== lower) } });
    return this.adminGet(t.id);
  },

  /**
   * support.sla-check: tickets past their first-response SLA with no agent answer → staff alert once
   * (rule `customer_ticket` recipients + the assignee). Returns the tickets flagged (tests).
   */
  async slaCheck(now = new Date()) {
    const rows = await prisma.ticket.findMany({
      where: { status: { in: ACTIVE_STATUSES }, firstResponseAt: null, slaBreachedAt: null, slaDueAt: { lt: now } },
      select: { id: true, number: true, subject: true, priority: true, slaDueAt: true, assigneeId: true, customerName: true },
    });
    const flagged: { id: string; number: string }[] = [];
    for (const t of rows) {
      const { count } = await prisma.ticket.updateMany({ where: { id: t.id, slaBreachedAt: null }, data: { slaBreachedAt: now } });
      if (!count) continue;
      flagged.push({ id: t.id, number: t.number });
      await notifyStaff("customer_ticket", {
        title: `SLA breached · ticket ${t.number}`,
        body: `${t.customerName}: "${t.subject}" (${t.priority}) was due a first response by ${t.slaDueAt!.toISOString()}.`,
        link: `/tickets?id=${t.id}`, entity: `ticket:${t.id}`, adminId: t.assigneeId,
      });
    }
    if (flagged.length) logger.info({ flagged: flagged.length }, "support tickets breached SLA");
    return flagged;
  },
};

export const supportSlaJob = defineJob("support.sla-check", async () => {
  await ticketsService.slaCheck();
});
