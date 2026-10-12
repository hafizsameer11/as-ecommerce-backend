/**
 * Concierge chat: one thread per request, customer ⇄ agent (+ system lines for quotes / status changes).
 * Unread counters live on the thread (unreadAgent / unreadCustomer); reading a thread clears your side.
 * Realtime: new messages are also pushed on the socket (`concierge.message` to `concierge:request:<id>`; typing via
 * `concierge:typing`, see core/realtime/realtime.ts). Polling GET …/messages and …/unread keeps working.
 */
import type { ChatMessage, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { logger } from "@/core/utils/logger";
import { env } from "@/config/env";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import { realtime } from "@/core/realtime/realtime";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { preferred } from "@/modules/support/notifications/notifications.service";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { requestKey } from "../concierge.common";
import { quoteBrief } from "../quotes/quotes.mapper";
import type { AgentSendBody, MessagesQuery, ThreadsQuery } from "./chat.schemas";

type Attachment = { name: string; kind: "image" | "file"; url: string };

async function toMessages(rows: ChatMessage[]) {
  const ids = [...new Set(rows.map((m) => m.quoteId).filter(Boolean) as string[])];
  const quotes = ids.length ? await prisma.conciergeQuote.findMany({ where: { id: { in: ids } } }) : [];
  return rows.map((m) => {
    const q = m.quoteId ? quotes.find((x) => x.id === m.quoteId) : null;
    return {
      id: m.id, sender: m.sender, authorName: m.authorName, channel: m.channel, text: m.text,
      attachments: (m.attachments as Attachment[] | null) ?? [], quote: q ? quoteBrief(q) : null,
      read: !!m.readAt, readAt: m.readAt, at: m.createdAt,
    };
  });
}

async function page(threadId: string, q: MessagesQuery) {
  const rows = await prisma.chatMessage.findMany({
    where: { threadId, ...(q.before ? { createdAt: { lt: q.before } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  return { messages: await toMessages(rows.slice(0, q.limit).reverse()), hasMore };
}

type OutMessage = Awaited<ReturnType<typeof toMessages>>[number];

/** socket: the request room, the customer's own room (for messages to them) and every admin who can see concierge */
function broadcast(r: { id: string; number: string; customerId: string | null }, message: OutMessage) {
  const rooms = [`concierge:request:${r.id}`, "admin:perm:concierge.view"];
  if (message.sender !== "customer" && r.customerId) rooms.push(`customer:${r.customerId}`);
  realtime.emit(rooms, "concierge.message", { requestId: r.id, number: r.number, message });
}

async function uploads(files: UploadInput[], by: string): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of files) {
    const m = await mediaService.upload(f, "concierge-chat", by);
    out.push({ name: f.originalname.slice(0, 190), kind: f.mimetype.startsWith("image/") ? "image" : "file", url: (m.variants as Record<string, string> | null)?.lg ?? m.url });
  }
  return out;
}

async function threadFor(where: Prisma.ConciergeRequestWhereInput) {
  const r = await prisma.conciergeRequest.findFirst({ where, select: { id: true, number: true, itemName: true, brand: true, status: true, priority: true, customerId: true, contactName: true, contactEmail: true, assigneeId: true } });
  if (!r) throw ApiError.notFound("Request");
  const thread = await prisma.chatThread.upsert({ where: { requestId: r.id }, create: { requestId: r.id }, update: {} });
  return { r, thread };
}

export const chatService = {
  // ── customer ──
  async customerMessages(customerId: string, requestId: string, q: MessagesQuery) {
    const { r, thread } = await threadFor({ customerId, ...requestKey(requestId) });
    const now = new Date();
    await prisma.$transaction([
      prisma.chatMessage.updateMany({ where: { threadId: thread.id, sender: { in: ["agent", "system"] }, readAt: null }, data: { readAt: now } }),
      prisma.chatThread.update({ where: { id: thread.id }, data: { unreadCustomer: 0 } }),
    ]);
    return { requestId: r.id, number: r.number, ...(await page(thread.id, q)), unread: 0 };
  },

  async customerSend(customerId: string, requestId: string, text: string, files: UploadInput[]) {
    const { r, thread } = await threadFor({ customerId, ...requestKey(requestId) });
    if (!text && !files.length) throw ApiError.badRequest("VALIDATION_FAILED", "Write a message or add a file.");
    const attachments = await uploads(files, `customer:${customerId}`);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { firstName: true, lastName: true } });
    const m = await prisma.$transaction(async (tx) => {
      const msg = await tx.chatMessage.create({ data: { threadId: thread.id, sender: "customer", authorName: fullName(c), text, attachments: attachments.length ? attachments : undefined } });
      await tx.chatThread.update({ where: { id: thread.id }, data: { unreadAgent: { increment: 1 }, lastAt: msg.createdAt } });
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { updatedAt: new Date() } });
      return msg;
    });
    const out = (await toMessages([m]))[0];
    broadcast(r, out);
    return out;
  },

  /** badge on the concierge entry points */
  async customerUnread(customerId: string) {
    const threads = await prisma.chatThread.findMany({
      where: { request: { customerId }, unreadCustomer: { gt: 0 } },
      select: { unreadCustomer: true, request: { select: { id: true, number: true } } },
    });
    return { total: threads.reduce((n, t) => n + t.unreadCustomer, 0), threads: threads.map((t) => ({ requestId: t.request.id, number: t.request.number, unread: t.unreadCustomer })) };
  },

  // ── admin ──
  async threads(q: ThreadsQuery, adminId: string) {
    const and: Prisma.ChatThreadWhereInput[] = [{ request: { status: { not: "cancelled" } } }];
    if (q.filter === "unread") and.push({ unreadAgent: { gt: 0 } });
    if (q.filter === "pinned") and.push({ pinned: true });
    if (q.filter === "vip") and.push({ request: { priority: "vip" } });
    if (q.assignee) and.push({ request: { assigneeId: q.assignee === "me" ? adminId : q.assignee === "unassigned" ? null : q.assignee } });
    if (q.q) and.push({ request: { OR: [{ number: { contains: q.q } }, { itemName: { contains: q.q } }, { brand: { contains: q.q } }, { contactName: { contains: q.q } }, { contactEmail: { contains: q.q } }] } });
    const where = { AND: and };
    const [rows, total, unread] = await Promise.all([
      prisma.chatThread.findMany({
        where, orderBy: [{ pinned: "desc" }, { lastAt: "desc" }], ...paging(q),
        include: {
          request: { select: { id: true, number: true, itemName: true, brand: true, status: true, priority: true, contactName: true, contactEmail: true, assigneeId: true, customer: { select: { tier: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      }),
      prisma.chatThread.count({ where }),
      prisma.chatThread.aggregate({ where: { request: { status: { not: "cancelled" } } }, _sum: { unreadAgent: true } }),
    ]);
    return withMeta(
      rows.map((t) => ({
        id: t.id, requestId: t.request.id, number: t.request.number, itemName: t.request.itemName, brand: t.request.brand,
        status: t.request.status, statusLabel: STATUS_LABELS.concierge.admin[t.request.status], priority: t.request.priority,
        customer: { name: t.request.contactName, email: t.request.contactEmail, tier: t.request.customer?.tier ?? null },
        assigneeId: t.request.assigneeId, pinned: t.pinned, unread: t.unreadAgent, lastAt: t.lastAt,
        last: t.messages[0] ? { sender: t.messages[0].sender, text: t.messages[0].text.slice(0, 160), at: t.messages[0].createdAt } : null,
      })),
      { ...pageMeta(q, total), totalUnread: unread._sum.unreadAgent ?? 0 },
    );
  },

  async adminMessages(requestId: string, q: MessagesQuery) {
    const { r, thread } = await threadFor(requestKey(requestId));
    await prisma.$transaction([
      prisma.chatMessage.updateMany({ where: { threadId: thread.id, sender: "customer", readAt: null }, data: { readAt: new Date() } }),
      prisma.chatThread.update({ where: { id: thread.id }, data: { unreadAgent: 0 } }),
    ]);
    return {
      thread: { id: thread.id, pinned: thread.pinned, unreadCustomer: thread.unreadCustomer },
      request: { id: r.id, number: r.number, itemName: r.itemName, brand: r.brand, status: r.status, priority: r.priority, customer: r.contactName, email: r.contactEmail },
      ...(await page(thread.id, q)),
    };
  },

  async agentSend(requestId: string, b: AgentSendBody, files: UploadInput[], admin: { id: string; name: string }) {
    const { r, thread } = await threadFor(requestKey(requestId));
    if (!b.text && !files.length && !b.quoteId) throw ApiError.badRequest("VALIDATION_FAILED", "Write a message or add a file.");
    if (b.quoteId && !(await prisma.conciergeQuote.findFirst({ where: { id: b.quoteId, requestId: r.id }, select: { id: true } })))
      throw ApiError.badRequest("VALIDATION_FAILED", "That quote isn't on this request.");
    const attachments = await uploads(files, `admin:${admin.id}`);
    const m = await prisma.$transaction(async (tx) => {
      const msg = await tx.chatMessage.create({
        data: { threadId: thread.id, sender: "agent", authorName: admin.name, channel: b.channel, text: b.text, quoteId: b.quoteId ?? null, attachments: attachments.length ? attachments : undefined },
      });
      // replying also clears what the agent had unread
      await tx.chatThread.update({ where: { id: thread.id }, data: { unreadCustomer: { increment: 1 }, unreadAgent: 0, lastAt: msg.createdAt } });
      await tx.chatMessage.updateMany({ where: { threadId: thread.id, sender: "customer", readAt: null }, data: { readAt: msg.createdAt } });
      return msg;
    });
    // app users get a push; guests (no account) get the message by e-mail
    const vars = { requestNumber: r.number, itemName: r.itemName, agent: admin.name, text: b.text || "Sent you a file.", requestUrl: `${env.WEB_URL}/track-request?id=${r.number}` };
    // push follows the customer's preferences (push + topic concierge)
    const notify = r.customerId
      ? preferred.push(r.customerId, "concierge", "concierge.message", vars, { requestId: r.id })
      : messaging.email(r.contactEmail, "concierge.message", vars);
    void notify.catch((err) => logger.error({ err }, "concierge message notification failed"));
    const out = (await toMessages([m]))[0];
    broadcast(r, out);
    return out;
  },

  async pin(requestId: string, pinned: boolean) {
    const { thread } = await threadFor(requestKey(requestId));
    const t = await prisma.chatThread.update({ where: { id: thread.id }, data: { pinned } });
    return { id: t.id, pinned: t.pinned };
  },
};
