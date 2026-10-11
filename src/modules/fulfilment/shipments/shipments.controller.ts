import type { Ctx } from "@/core/http/router";
import { shipmentsService as svc } from "./shipments.service";
import type { AdvanceBody, CreateShipmentBody, FulfilBody, ShipmentListQuery, UpdateShipmentBody } from "./shipments.schemas";

type Id = { id: string };

export const shipmentsController = {
  // admin
  fulfil: async ({ params, body, admin, res }: Ctx<FulfilBody, unknown, Id>) => {
    const s = await svc.fulfil(params.id, body, admin.name);
    res.locals.audit = { entityId: s.orderId, after: s, summary: `Fulfilled ${s.orderNumber} with ${s.number} (${s.carrierLabel} · ${s.service})` };
    return s;
  },
  create: async ({ body, admin, res }: Ctx<CreateShipmentBody>) => {
    const s = await svc.create(body, admin.name);
    res.locals.audit = { entityId: s.id, after: s, summary: `Created shipment ${s.number} for ${s.orderNumber}` };
    return s;
  },
  list: ({ query }: Ctx<unknown, ShipmentListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  update: async ({ params, body, res }: Ctx<UpdateShipmentBody, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated shipment ${r.after.number}` };
    return r.after;
  },
  advance: async ({ params, body, admin, res }: Ctx<AdvanceBody, unknown, Id>) => {
    const s = await svc.advance(params.id, body, admin.name);
    res.locals.audit = { entityId: s.id, summary: `Shipment ${s.number} → ${s.statusLabel} (${body.location})` };
    return s;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { summary: `Deleted shipment ${r.number}` };
    return r;
  },

  // customer
  myTracking: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.tracking({ customerId, OR: [{ id: params.id }, { number: params.id }] }),
  tokenTracking: ({ params }: Ctx<unknown, unknown, { token: string }>) => svc.tracking({ accessToken: params.token }),
};
