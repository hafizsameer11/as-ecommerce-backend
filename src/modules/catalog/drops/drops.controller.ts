import type { Ctx } from "@/core/http/router";
import { dropsService as svc } from "./drops.service";
import { reservationsService as rsv } from "./reservations.service";
import type {
  AdminCancelReservationBody, AdminDropsQuery, AdminReservationsQuery, CancelReservationBody, CreateDropBody, MyReservationsQuery,
  NotifyMeBody, NotifyMeQuery, PayBalanceBody, ReserveBody, UpdateDropBody,
} from "./drops.schemas";

type Id = { id: string };
type DropRes = { id: string; rid: string };

export const dropsController = {
  list: () => svc.list(),
  get: ({ params, customerId }: Ctx<unknown, unknown, Id>) => svc.get(params.id, customerId || undefined),

  notifyMe: ({ customerId, params, body }: Ctx<NotifyMeBody, unknown, Id>) => svc.subscribeStockAlert(customerId, params.id, body.size),
  stopNotifying: ({ customerId, params, query }: Ctx<unknown, NotifyMeQuery, Id>) => svc.unsubscribeStockAlert(customerId, params.id, query.size),

  // reservations (customer)
  reserve: ({ customerId, params, body }: Ctx<ReserveBody, unknown, Id>) => rsv.reserve(customerId, params.id, body),
  myReservations: ({ customerId, query }: Ctx<unknown, MyReservationsQuery>) => rsv.listMine(customerId, query),
  myReservation: ({ customerId, params }: Ctx<unknown, unknown, Id>) => rsv.mine(customerId, params.id),
  cancelMine: ({ customerId, params, body }: Ctx<CancelReservationBody, unknown, Id>) => rsv.cancelMine(customerId, params.id, body.reason),
  payBalance: ({ customerId, params, body }: Ctx<PayBalanceBody, unknown, Id>) => rsv.payBalance(customerId, params.id, body),

  // admin
  adminList: ({ query }: Ctx<unknown, AdminDropsQuery>) => svc.adminList(query),
  adminGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  create: async ({ body, res }: Ctx<CreateDropBody>) => {
    const d = await svc.create(body);
    res.locals.audit = { entityId: d.id, summary: `Created drop for ${d.product.name} (${d.allocation} pieces)`, after: d };
    return d;
  },
  update: async ({ params, body, res }: Ctx<UpdateDropBody, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, summary: `Updated drop ${r.after.product.name}`, before: r.before, after: r.after };
    return r.after;
  },
  goLive: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const d = await svc.goLive(params.id, admin.name);
    res.locals.audit = { entityId: d.id, summary: `Released drop ${d.product.name} (${d.release.notified} reservation holders notified)` };
    return d;
  },
  end: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const d = await svc.end(params.id, admin.name);
    res.locals.audit = { entityId: d.id, summary: `Ended drop ${d.product.name}` };
    return d;
  },
  reservations: ({ params, query }: Ctx<unknown, AdminReservationsQuery, Id>) => rsv.adminList(params.id, query),
  reservation: ({ params }: Ctx<unknown, unknown, DropRes>) => rsv.adminGet(params.id, params.rid),
  cancelReservation: async ({ params, body, admin, res }: Ctx<AdminCancelReservationBody, unknown, DropRes>) => {
    const r = await rsv.adminCancel(params.id, params.rid, body, admin.name);
    res.locals.audit = {
      entityId: r.after.id, before: r.before, after: r.after,
      summary: `Cancelled reservation ${r.after.number} (${r.after.customer.email}) · deposit ${body.refundTo === "none" ? "kept" : `refunded to ${body.refundTo}`} · ${body.reason}`,
    };
    return r.after;
  },
};
