import type { Ctx } from "@/core/http/router";
import { returnsService as svc } from "./returns.service";
import type { AdminCreateBody, AdminReturnsQuery, CreateReturnBody, MyReturnsQuery, ReceivedBody, ReturnRefundBody } from "./returns.schemas";

type Id = { id: string };
type Note = { note?: string };

/** audit summary for admin actions */
const audited = async <T extends { number: string; status: string }>(res: Ctx["res"], p: Promise<T>, verb: string) => {
  const r = await p;
  res.locals.audit = { summary: `${verb} return ${r.number} → ${r.status}`, after: { status: r.status } };
  return r;
};

export const returnsController = {
  // customer
  returnable: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.returnable(customerId, params.id),
  myReturns: ({ customerId, query }: Ctx<unknown, MyReturnsQuery>) => svc.myReturns(customerId, query),
  myReturn: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.myReturn(customerId, params.id),
  create: ({ customerId, body, files }: Ctx<CreateReturnBody>) => svc.create(customerId, body, files),
  cancel: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.cancelByCustomer(customerId, params.id),

  // admin
  list: ({ query }: Ctx<unknown, AdminReturnsQuery>) => svc.adminList(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  adminCreate: async ({ body, admin, res }: Ctx<AdminCreateBody>) => {
    const r = await svc.adminCreate(body, admin.name);
    res.locals.audit = { entityId: r.id, summary: `Created return ${r.number} for order ${r.order}`, after: { status: r.status, refund: r.refund } };
    return r;
  },
  approve: ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => audited(res, svc.approve(params.id, body.note, admin.name), "Approved"),
  reject: ({ params, body, admin, res }: Ctx<{ reason: string }, unknown, Id>) => audited(res, svc.reject(params.id, body.reason, admin.name), "Rejected"),
  inTransit: ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => audited(res, svc.inTransit(params.id, body.note, admin.name), "Updated"),
  received: ({ params, body, admin, res }: Ctx<ReceivedBody, unknown, Id>) => audited(res, svc.received(params.id, body, admin.name), "Received"),
  investigate: ({ params, body, admin, res }: Ctx<{ note: string }, unknown, Id>) => audited(res, svc.investigate(params.id, body.note, admin.name), "Investigating"),
  refund: ({ params, body, admin, res }: Ctx<ReturnRefundBody, unknown, Id>) => audited(res, svc.refund(params.id, body, admin.name), "Refunded"),
};
