import { ModuleRouter, idParam } from "@/core/http/router";
import { lookupLimiter } from "@/core/middleware/rate-limit";
import { ticketsController as c } from "./tickets.controller";
import {
  adminTicketsQuery, assignBody, contactBody, createTicketBody, customerMessageBody, myTicketsQuery, priorityBody, replyBody, statusBody, tagBody, tagParam, ticketPatch,
} from "./tickets.schemas";

const files = { field: "attachments", maxCount: 5, maxMB: 10, accept: /^(image\/(jpeg|png|webp|gif|heic|heif|avif)|application\/pdf)$/ };

/** /account/help/contact (signed in) and /customer-care/contact-us (guest) */
export const supportStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/support", tag: "Support", defaultAuth: "customer" })
  .post("/tickets", {
    summary: "Open a ticket: topic + message (multipart: up to 5 `attachments`, images / PDF) → reference \"#5201\"",
    upload: files, body: createTicketBody, status: 201,
  }, c.create)
  .post("/contact", {
    summary: "Contact form (guest: name, email, subject, message) → ticket + confirmation e-mail",
    description: "Linked to the account when the caller is signed in. Rate limited.",
    auth: "optionalCustomer", middleware: [lookupLimiter], body: contactBody, status: 201,
  }, c.contact);

/** /account/tickets, /account/tickets/:id */
export const myTicketsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/tickets", tag: "Support", defaultAuth: "customer" })
  .get("/", { summary: "My tickets (tabs: all / open / closed)", query: myTicketsQuery }, c.myList)
  .get("/:id", { summary: "Ticket thread (id or #number) — internal notes are never included", params: idParam }, c.myGet)
  .post("/:id/messages", { summary: "Reply (multipart: `body` + up to 5 `attachments`); not allowed once closed", params: idParam, upload: files, body: customerMessageBody, status: 201 }, c.message)
  .post("/:id/reopen", { summary: "Reopen a resolved / closed ticket", params: idParam }, c.reopen);

const audit = (action: string) => ({ category: "support", action, entity: "ticket" });

/** asl-admin /tickets */
export const ticketsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/tickets", tag: "Support", defaultAuth: "admin", defaultPermission: "support.tickets" })
  .get("/", {
    summary: "Inbox: tabs (all / status / unassigned / mine / breached), filters (priority, channel, category, assignee id|me|none, tag, q); KPIs",
    query: adminTicketsQuery,
  }, c.adminList)
  .get("/:id", { summary: "Ticket with the full thread (internal notes included)", params: idParam }, c.adminGet)
  .post("/:id/reply", {
    summary: "Reply to the customer, or add an internal note (`internal: true`). Multipart allowed (`attachments`)",
    permission: "support.reply", params: idParam, upload: files, body: replyBody, audit: audit("ticket.replied"),
  }, c.reply)
  .patch("/:id", { summary: "Change status / priority / category", params: idParam, body: ticketPatch, audit: audit("ticket.updated") }, c.update)
  .patch("/:id/status", { summary: "Change status", params: idParam, body: statusBody, audit: audit("ticket.status_changed") }, c.setStatus)
  .patch("/:id/priority", { summary: "Change priority (SLA follows until the first response)", params: idParam, body: priorityBody, audit: audit("ticket.priority_changed") }, c.setPriority)
  .post("/:id/assign", { summary: "Assign to a team member with support access (adminId null = unassign)", params: idParam, body: assignBody, audit: audit("ticket.assigned") }, c.assign)
  .post("/:id/tags", { summary: "Add a tag", params: idParam, body: tagBody, audit: audit("ticket.tagged") }, c.addTag)
  .delete("/:id/tags/:tag", { summary: "Remove a tag", params: tagParam, audit: audit("ticket.untagged") }, c.removeTag);
