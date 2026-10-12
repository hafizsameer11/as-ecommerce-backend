import type { Ctx } from "@/core/http/router";
import type { ConciergePriority } from "@/generated/prisma/client";
import { requestsService as svc } from "./requests.service";
import type { AdminRequestsQuery, CreateRequestBody, MyRequestsQuery, NoteBody, StatusBody } from "./requests.schemas";

type Id = { id: string };

/** audit summary for admin actions */
const audited = async <T extends { id: string; number: string; status: string }>(res: Ctx["res"], p: Promise<T>, verb: string) => {
  const r = await p;
  res.locals.audit = { entityId: r.id, summary: `${verb} concierge request ${r.number}`, after: { status: r.status } };
  return r;
};

export const requestsController = {
  // customer / public
  create: ({ req, body, files }: Ctx<CreateRequestBody>) => svc.create(req.customer?.id ?? null, body, files),
  myList: ({ customerId, query }: Ctx<unknown, MyRequestsQuery>) => svc.myList(customerId, query),
  myGet: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.myGet(customerId, params.id),
  cancel: ({ customerId, params, body }: Ctx<{ reason?: string }, unknown, Id>) => svc.cancelByCustomer(customerId, params.id, body.reason),
  cart: ({ customerId }: Ctx) => svc.cart(customerId),
  track: ({ req, params, query }: Ctx<unknown, { email?: string }, { number: string }>) => svc.track(params.number, query.email, req.customer?.id),

  // admin
  list: ({ query, admin }: Ctx<unknown, AdminRequestsQuery>) => svc.adminList(query, admin.id),
  board: ({ query, admin }: Ctx<unknown, AdminRequestsQuery>) => svc.board(query, admin.id),
  kpis: () => svc.kpis(),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  setStatus: ({ params, body, admin, res }: Ctx<StatusBody, unknown, Id>) => audited(res, svc.setStatus(params.id, body, admin.name), `Status → ${body.status} on`),
  assign: ({ params, body, admin, res }: Ctx<{ adminId: string | null }, unknown, Id>) =>
    audited(res, svc.assign(params.id, body.adminId, admin), body.adminId ? "Assigned" : "Unassigned"),
  setPriority: ({ params, body, admin, res }: Ctx<{ priority: ConciergePriority }, unknown, Id>) =>
    audited(res, svc.setPriority(params.id, body.priority, admin.name), `Priority ${body.priority} on`),
  setSupplier: ({ params, body, admin, res }: Ctx<{ supplierId: string | null }, unknown, Id>) => audited(res, svc.setSupplier(params.id, body.supplierId, admin.name), "Linked supplier on"),
  addNote: ({ params, body, admin, res }: Ctx<NoteBody, unknown, Id>) => audited(res, svc.addNote(params.id, body, admin.name), "Note on"),
};
