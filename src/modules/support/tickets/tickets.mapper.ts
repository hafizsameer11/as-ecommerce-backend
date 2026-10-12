import type { Ticket, TicketMessage } from "@/generated/prisma/client";
import type { TicketCategory, TicketStatus } from "@/generated/prisma/enums";

/** wording per screen (asl-web /account/tickets chips, asl-admin /tickets) */
export const TICKET_LABELS = {
  customer: { open: "Open", pending: "Awaiting You", on_hold: "On Hold", resolved: "Resolved", closed: "Closed" },
  admin: { open: "Open", pending: "Awaiting customer", on_hold: "On hold", resolved: "Resolved", closed: "Closed" },
} as const satisfies Record<string, Record<TicketStatus, string>>;

export const CLOSED_STATUSES: TicketStatus[] = ["resolved", "closed"];
export const ACTIVE_STATUSES: TicketStatus[] = ["open", "pending", "on_hold"];

/** topic / subject wording from the two forms → category */
const CATEGORY_WORDS: [RegExp, TicketCategory][] = [
  [/return|refund|exchange/i, "returns"],
  [/concierge|sourcing/i, "concierge"],
  [/payment|wallet|charge|card/i, "payment"],
  [/ship|deliver|track|courier/i, "delivery"],
  [/order/i, "order"],
  [/account|login|log in|password|sign/i, "account"],
  [/product|size|authentic/i, "product"],
];
export const guessCategory = (text: string): TicketCategory => CATEGORY_WORDS.find(([re]) => re.test(text))?.[1] ?? "other";

type Attachment = { name: string; kind: "image" | "file"; url: string };
const attachments = (m: TicketMessage) => (m.attachments as Attachment[] | null) ?? [];
const tags = (t: Ticket) => (t.tags as string[] | null) ?? [];

export type SlaState = "ok" | "at_risk" | "breached" | "met" | "missed" | "none";

/** first-response SLA: due `slaDueAt`; at risk in the last quarter of the window (max 2 h) */
export function slaState(t: Pick<Ticket, "status" | "createdAt" | "slaDueAt" | "firstResponseAt">, now = Date.now()): SlaState {
  if (!t.slaDueAt) return "none";
  const due = t.slaDueAt.getTime();
  if (t.firstResponseAt) return t.firstResponseAt.getTime() <= due ? "met" : "missed";
  if (CLOSED_STATUSES.includes(t.status)) return "none";
  if (now > due) return "breached";
  const window = due - t.createdAt.getTime();
  return due - now <= Math.min(2 * 3_600_000, window / 4) ? "at_risk" : "ok";
}

const customerMessage = (m: TicketMessage) => ({
  id: m.id, author: m.author, authorName: m.author === "agent" ? m.authorName : m.author === "system" ? "ASL ORIGINALS" : m.authorName,
  body: m.body, attachments: attachments(m), at: m.createdAt,
});

/** customer view: internal notes are never included */
type WithMessages = Ticket & { messages: TicketMessage[]; _count?: { messages: number } };

export function toCustomerTicket(t: WithMessages, withMessages = true) {
  const visible = t.messages.filter((m) => !m.internal);
  const last = visible[visible.length - 1];
  return {
    id: t.id, number: t.number, subject: t.subject, category: t.category, orderRef: t.orderRef,
    statusKey: t.status, status: TICKET_LABELS.customer[t.status],
    canReply: t.status !== "closed", canReopen: CLOSED_STATUSES.includes(t.status),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    lastMessage: last ? { author: last.author, body: last.body.slice(0, 200), at: last.createdAt } : null,
    messageCount: t._count?.messages ?? visible.length,
    ...(withMessages ? { messages: visible.map(customerMessage) } : {}),
  };
}

export function toAdminTicket(t: WithMessages, names: Map<string, string>, withMessages = false) {
  const last = t.messages[t.messages.length - 1];
  return {
    id: t.id, number: t.number, subject: t.subject, status: t.status, statusLabel: TICKET_LABELS.admin[t.status],
    priority: t.priority, channel: t.channel, category: t.category,
    customerId: t.customerId, customerName: t.customerName, customerEmail: t.customerEmail, customerCreated: t.customerCreated,
    orderRef: t.orderRef,
    assigneeId: t.assigneeId, assignee: t.assigneeId ? (names.get(t.assigneeId) ?? null) : null,
    tags: tags(t),
    createdAt: t.createdAt, updatedAt: t.updatedAt, firstResponseAt: t.firstResponseAt, resolvedAt: t.resolvedAt,
    slaDueAt: t.slaDueAt, sla: slaState(t), slaBreachedAt: t.slaBreachedAt,
    lastMessage: last ? { author: last.author, authorName: last.authorName, body: last.body.slice(0, 200), internal: last.internal, at: last.createdAt } : null,
    messageCount: t._count?.messages ?? t.messages.length,
    ...(withMessages
      ? { messages: t.messages.map((m) => ({ id: m.id, author: m.author, authorName: m.authorName, body: m.body, internal: m.internal, attachments: attachments(m), at: m.createdAt })) }
      : {}),
  };
}
