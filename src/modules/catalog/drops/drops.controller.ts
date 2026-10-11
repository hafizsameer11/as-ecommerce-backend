import type { Ctx } from "@/core/http/router";
import { dropsService as svc } from "./drops.service";
import type { NotifyMeBody, NotifyMeQuery } from "./drops.schemas";

type Id = { id: string };

export const dropsController = {
  list: () => svc.list(),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),

  notifyMe: ({ customerId, params, body }: Ctx<NotifyMeBody, unknown, Id>) => svc.subscribeStockAlert(customerId, params.id, body.size),
  stopNotifying: ({ customerId, params, query }: Ctx<unknown, NotifyMeQuery, Id>) => svc.unsubscribeStockAlert(customerId, params.id, query.size),
};
