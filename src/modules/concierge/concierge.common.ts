/**
 * Helpers shared by the concierge sub-modules (requests, quotes, chat):
 * the status lifecycle, timeline + system chat entries, SLA maths and staff in-app notifications.
 *
 *   new → sourcing → quoted → payment_pending → (approved + balance due) → ordered → in_transit → delivered
 *   side exits: cancelled, unavailable
 */
import type { ConciergePriority, ConciergeStatus, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { logger } from "@/core/utils/logger";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";

type Db = Tx | typeof prisma;

export const SYSTEM = "System";

/** statuses still being worked on */
export const OPEN_STATUSES: ConciergeStatus[] = ["new", "sourcing", "quoted", "approved", "payment_pending", "ordered", "in_transit"];
export const CLOSED_STATUSES: ConciergeStatus[] = ["delivered", "cancelled", "unavailable"];
/** the response SLA runs until the first quote is sent */
export const SLA_STATUSES: ConciergeStatus[] = ["new", "sourcing"];
/** the customer can still cancel (nothing paid yet) */
export const CUSTOMER_CANCELLABLE: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending"];

/**
 * Status moves staff may make by hand (inbox select / board drag).
 * `quoted` only comes from sending a quote; `payment_pending` / `approved` only from the customer accepting + paying.
 */
export const ADMIN_TRANSITIONS: Record<ConciergeStatus, ConciergeStatus[]> = {
  new: ["sourcing", "cancelled", "unavailable"],
  sourcing: ["new", "cancelled", "unavailable"],
  quoted: ["sourcing", "cancelled", "unavailable"],
  payment_pending: ["sourcing", "cancelled"],
  approved: ["ordered"],
  ordered: ["in_transit"],
  in_transit: ["delivered"],
  delivered: [],
  cancelled: [],
  unavailable: ["sourcing"],
};

/** customer /account/requests chips */
export const CUSTOMER_TABS = {
  all: null,
  progress: ["new", "sourcing", "quoted", "approved", "payment_pending", "ordered", "in_transit"],
  completed: ["delivered"],
  cancelled: ["cancelled", "unavailable"],
} as const satisfies Record<string, ConciergeStatus[] | null>;

export function assertTransition(from: ConciergeStatus, to: ConciergeStatus) {
  if (from === to) return;
  if (!ADMIN_TRANSITIONS[from].includes(to))
    throw ApiError.conflict("INVALID_STATE", `A request that is ${from.replace("_", " ")} can't be moved to ${to.replace("_", " ")}.`, {
      from, to, allowed: ADMIN_TRANSITIONS[from],
    });
}

// ── SLA ──
const HOUR = 3_600_000;
export const slaDue = (from: Date, priority: ConciergePriority, cfg: SettingsOf<"concierge">) =>
  new Date(from.getTime() + cfg.responseSlaHours[priority] * HOUR);

/** ok | at_risk (last 25 % of the window) | breached; null once the SLA no longer applies */
export function slaLevel(r: { status: ConciergeStatus; slaDueAt: Date | null; priority: ConciergePriority }, cfg: SettingsOf<"concierge">, now = Date.now()) {
  if (!r.slaDueAt || !SLA_STATUSES.includes(r.status)) return null;
  const left = r.slaDueAt.getTime() - now;
  if (left <= 0) return "breached" as const;
  return left <= cfg.responseSlaHours[r.priority] * HOUR * 0.25 ? ("at_risk" as const) : ("ok" as const);
}

// ── timeline + chat ──
export async function addTimeline(db: Db, requestId: string, kind: "note" | "status" | "message" | "quote", text: string, by: string, internal = false) {
  await db.conciergeTimelineEntry.create({ data: { requestId, kind, text: text.slice(0, 5000), by, internal } });
}

/** system line in the chat thread (quote cards, status changes); counts as unread for the customer */
export async function systemMessage(db: Db, requestId: string, text: string, quoteId?: string) {
  const thread = await db.chatThread.upsert({ where: { requestId }, create: { requestId }, update: {} });
  await db.chatMessage.create({ data: { threadId: thread.id, sender: "system", authorName: SYSTEM, text, quoteId: quoteId ?? null } });
  await db.chatThread.update({ where: { id: thread.id }, data: { unreadCustomer: { increment: 1 }, lastAt: new Date() } });
}

/**
 * Moves a request to `to` inside the caller's transaction: closes unpaid quotes when it leaves the quote stage,
 * counts a supplier order on `ordered`, and writes the customer-visible timeline + chat line.
 * Callers emit `concierge.status_changed` after commit.
 */
export async function applyStatus(
  tx: Tx,
  r: { id: string; supplierId: string | null; quotes: { itemsTotal: number }[] },
  to: ConciergeStatus,
  by: string,
  note?: string,
) {
  const data: Prisma.ConciergeRequestUpdateInput = { status: to };
  if (to === "cancelled") data.cancelledAt = new Date();
  if (["new", "sourcing", "cancelled", "unavailable"].includes(to))
    await tx.conciergeQuote.updateMany({
      where: { requestId: r.id, status: { in: ["sent", "accepted"] }, amountPaid: 0 },
      data: { status: to === "cancelled" ? "declined" : "expired" },
    });
  if (to === "ordered" && r.supplierId)
    await tx.supplier.update({
      where: { id: r.supplierId },
      data: { totalOrders: { increment: 1 }, totalSpend: { increment: BigInt(r.quotes[0]?.itemsTotal ?? 0) }, lastOrderAt: new Date() },
    });
  await tx.conciergeRequest.update({ where: { id: r.id }, data });
  const label = STATUS_LABELS.concierge.customer[to];
  await addTimeline(tx, r.id, "status", note ? `${label}: ${note}` : `Status updated: ${label}`, by);
  await systemMessage(tx, r.id, note ? `Status updated: ${label}. ${note}` : `Status updated: ${label}.`);
}

// ── staff in-app notifications (NotificationRule → AdminNotification) ──
/**
 * Creates in-app notifications for a seeded staff rule (`concierge_request`, `concierge_sla`, `concierge_quote`):
 * one per recipient role (the admin app shows role notifications to everyone with that role), plus one for `adminId` when given.
 * Disabled rules or rules without the in-app channel create nothing.
 */
export async function notifyStaff(ruleId: string, n: { title: string; body: string; link?: string; adminId?: string | null }) {
  try {
    const rule = await prisma.notificationRule.findUnique({ where: { id: ruleId } });
    if (!rule || !rule.enabled || !(rule.channels as { in_app?: boolean })?.in_app) return;
    const roles = (rule.recipients as string[]).filter((r) => !r.includes("@"));
    const data: Prisma.AdminNotificationCreateManyInput[] = roles.map((role) => ({ role, ruleId, title: n.title, body: n.body, link: n.link ?? null, priority: rule.priority }));
    if (n.adminId) data.push({ adminId: n.adminId, ruleId, title: n.title, body: n.body, link: n.link ?? null, priority: rule.priority });
    if (data.length) await prisma.adminNotification.createMany({ data });
  } catch (err) {
    logger.error({ err, ruleId }, "staff notification failed");
  }
}

/** accept a request id or its ASL number */
export const requestKey = (id: string): Prisma.ConciergeRequestWhereInput => ({ OR: [{ id }, { number: id.toUpperCase() }] });
