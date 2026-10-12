/**
 * Concierge notifications: customer e-mail (guests included) + push for app users, staff in-app notifications.
 */
import { env } from "@/config/env";
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { notifyStaff } from "../concierge.common";

/** statuses the customer hears about (sourcing / quoted have their own messages) */
const ANNOUNCE = new Set(["approved", "ordered", "in_transit", "delivered", "cancelled", "unavailable"]);

async function context(requestId: string) {
  const r = await prisma.conciergeRequest.findUnique({ where: { id: requestId }, include: { customer: { select: { firstName: true } } } });
  if (!r) return null;
  const vars = {
    firstName: r.customer?.firstName || r.contactName.split(" ")[0] || "there",
    requestNumber: r.number,
    itemName: [r.brand, r.itemName].filter(Boolean).join(" "),
    status: STATUS_LABELS.concierge.customer[r.status],
    requestUrl: r.customerId ? `${env.WEB_URL}/account/requests?id=${r.number}` : `${env.WEB_URL}/track-request?id=${r.number}`,
  };
  return { r, vars };
}

export function registerConciergeListeners() {
  events.on("concierge.requested", async ({ requestId }) => {
    const c = await context(requestId);
    if (!c) return;
    await messaging.email(c.r.contactEmail, "concierge.received", c.vars);
    await notifyStaff("concierge_request", {
      title: `New concierge request · ${c.r.number}`,
      body: `${c.r.contactName}: ${c.vars.itemName} (${c.r.category}, ${c.r.priority}).`,
      link: `/concierge/inbox?id=${c.r.id}`,
    });
  });

  events.on("concierge.quoted", async ({ quoteId }) => {
    const q = await prisma.conciergeQuote.findUnique({ where: { id: quoteId } });
    const c = q && (await context(q.requestId));
    if (!q || !c) return;
    const vars = { ...c.vars, quoteNumber: q.number, total: formatNaira(q.total), deposit: formatNaira(q.deposit), expiresAt: q.expiresAt.toUTCString() };
    await messaging.email(c.r.contactEmail, "concierge.quoted", vars);
    if (c.r.customerId) await messaging.push(c.r.customerId, "concierge.quoted", vars, { requestId: c.r.id });
  });

  events.on("concierge.status_changed", async ({ requestId, to }) => {
    if (!ANNOUNCE.has(to)) return;
    const c = await context(requestId);
    if (!c) return;
    await messaging.email(c.r.contactEmail, "concierge.status", c.vars);
    if (c.r.customerId) await messaging.push(c.r.customerId, "concierge.status", c.vars, { requestId: c.r.id });
  });
}
