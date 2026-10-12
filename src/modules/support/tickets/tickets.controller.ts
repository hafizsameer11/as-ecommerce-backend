import type { Ctx } from "@/core/http/router";
import { ticketsService as svc } from "./tickets.service";
import type {
  AdminTicketsQuery, AssignBody, ContactBody, CreateTicketBody, CustomerMessageBody, MyTicketsQuery, PriorityBody, ReplyBody, StatusBody, TagBody, TicketPatch,
} from "./tickets.schemas";

type Id = { id: string };

export const ticketsController = {
  // customer
  create: ({ customerId, body, files }: Ctx<CreateTicketBody>) => svc.create(customerId, body, files),
  contact: ({ req, body }: Ctx<ContactBody>) => svc.contact(body, req.customer?.id),
  myList: ({ customerId, query }: Ctx<unknown, MyTicketsQuery>) => svc.myList(customerId, query),
  myGet: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.myGet(customerId, params.id),
  message: ({ customerId, params, body, files }: Ctx<CustomerMessageBody, unknown, Id>) => svc.customerMessage(customerId, params.id, body.body, files),
  reopen: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.reopen(customerId, params.id),

  // admin /tickets
  adminList: ({ query, admin }: Ctx<unknown, AdminTicketsQuery>) => svc.adminList(query, admin.id),
  adminGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  reply: async ({ params, body, files, admin, res }: Ctx<ReplyBody, unknown, Id>) => {
    const t = await svc.reply(params.id, body, files, admin);
    res.locals.audit = { entityId: t.id, summary: `${body.internal ? "Internal note on" : "Replied to"} ticket ${t.number}` };
    return t;
  },
  update: async ({ params, body, admin, res }: Ctx<TicketPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body, admin);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: { status: r.after.status, priority: r.after.priority, category: r.after.category }, summary: `Updated ticket ${r.after.number}` };
    return r.after;
  },
  setStatus: async (ctx: Ctx<StatusBody, unknown, Id>) => ticketsController.update({ ...ctx, body: { status: ctx.body.status } }),
  setPriority: async (ctx: Ctx<PriorityBody, unknown, Id>) => ticketsController.update({ ...ctx, body: { priority: ctx.body.priority } }),
  assign: async ({ params, body, admin, res }: Ctx<AssignBody, unknown, Id>) => {
    const t = await svc.assign(params.id, body.adminId, admin);
    res.locals.audit = { entityId: t.id, summary: t.assignee ? `Assigned ticket ${t.number} to ${t.assignee}` : `Unassigned ticket ${t.number}` };
    return t;
  },
  addTag: ({ params, body }: Ctx<TagBody, unknown, Id>) => svc.addTag(params.id, body.tag),
  removeTag: ({ params }: Ctx<unknown, unknown, Id & { tag: string }>) => svc.removeTag(params.id, params.tag),
};
