/**
 * Ticket side effects:
 *  created        → "ticket.received" e-mail to the customer / guest, inbox row, staff alert (rule customer_ticket)
 *  agent replied  → "ticket.reply" e-mail (always: transactional, guests too) + inbox row and push (push respects preferences)
 *  customer wrote → bell row for the assignee
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { notifyStaff } from "@/modules/platform/notification-settings/notification-settings.service";
import { notify } from "@/modules/support/notifications/notifications.service";

let registered = false;

export function registerTicketListeners() {
  if (registered) return;
  registered = true;

  events.on("ticket.created", async ({ ticketId }) => {
    const t = await prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!t) return;
    await messaging.email(t.customerEmail, "ticket.received", { ticketNumber: t.number, subject: t.subject, name: t.customerName });
    if (t.customerId)
      await notify(t.customerId, {
        category: "Account", title: "Request Received", icon: "LifeBuoy",
        message: `We received your request "${t.subject}". Reference ${t.number}.`, ctaLabel: "View Ticket", ctaLink: `/account/tickets/${t.id}`,
      });
    await notifyStaff("customer_ticket", {
      title: `New ticket ${t.number}`, body: `${t.customerName} (${t.customerEmail}): ${t.subject}`,
      link: `/tickets?id=${t.id}`, entity: `ticket:${t.id}`,
    });
  });

  events.on("ticket.replied", async ({ ticketId, by }) => {
    const t = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { messages: { where: by === "agent" ? { author: "agent", internal: false } : { author: { in: ["customer", "system"] } }, orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const m = t?.messages[0];
    if (!t || !m) return;
    if (by === "agent") {
      const vars = { ticketNumber: t.number, subject: t.subject, agent: m.authorName, body: m.body, preview: m.body.slice(0, 120) };
      await messaging.email(t.customerEmail, "ticket.reply", vars);
      if (t.customerId)
        await notify(t.customerId, {
          category: "Account", title: "Client Support replied", icon: "MessageCircle",
          message: `${m.authorName} replied to ${t.number}: ${m.body.slice(0, 140)}`, ctaLabel: "View Reply", ctaLink: `/account/tickets/${t.id}`,
          template: { code: "ticket.reply", vars, data: { type: "ticket", ticketId: t.id } }, channels: ["push"],
        });
      return;
    }
    if (t.assigneeId)
      await prisma.adminNotification.create({
        data: {
          adminId: t.assigneeId, title: `${t.customerName} replied · ${t.number}`, body: m.body.slice(0, 300),
          link: `/tickets?id=${t.id}`, priority: t.priority === "urgent" ? "high" : "normal",
        },
      });
  });
}
