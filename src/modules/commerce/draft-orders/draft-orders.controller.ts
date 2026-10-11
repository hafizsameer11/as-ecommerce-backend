import type { Ctx } from "@/core/http/router";
import { draftOrdersService as svc } from "./draft-orders.service";
import type { ConvertDraftBody, CreateDraftBody, DraftListQuery, PayDraftBody, SendDraftBody, UpdateDraftBody } from "./draft-orders.schemas";

type Id = { id: string };
type Token = { token: string };

export const draftOrdersController = {
  // admin
  list: ({ query }: Ctx<unknown, DraftListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, admin, res }: Ctx<CreateDraftBody>) => {
    const d = await svc.create(body, admin.name);
    res.locals.audit = { entityId: d.id, summary: `Created draft ${d.number} (${d.customerName})`, after: d };
    return d;
  },
  update: async ({ params, body, res }: Ctx<UpdateDraftBody, unknown, Id>) => {
    const before = await svc.get(params.id);
    const d = await svc.update(params.id, body);
    res.locals.audit = { entityId: d.id, summary: `Updated draft ${d.number}`, before, after: d };
    return d;
  },
  duplicate: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const d = await svc.duplicate(params.id, admin.name);
    res.locals.audit = { entityId: d.id, summary: `Duplicated draft as ${d.number}` };
    return d;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { entityId: r.id, summary: `Deleted draft ${r.number}` };
    return r;
  },
  send: async ({ params, body, res }: Ctx<SendDraftBody, unknown, Id>) => {
    const d = await svc.send(params.id, body.email);
    res.locals.audit = { entityId: d.id, summary: `Pay link for ${d.number} sent to ${d.email}` };
    return d;
  },
  convert: async ({ params, body, admin, res }: Ctx<ConvertDraftBody, unknown, Id>) => {
    const d = await svc.convert(params.id, body, admin.name);
    res.locals.audit = { entityId: d.id, summary: `Draft ${d.number} paid offline (${body.method} ${body.reference}) → order ${d.orderNumber}` };
    return d;
  },

  // customer pay link
  payView: ({ params }: Ctx<unknown, unknown, Token>) => svc.payView(params.token),
  pay: ({ params, body }: Ctx<PayDraftBody, unknown, Token>) => svc.pay(params.token, body),
};
