import type { Ctx } from "@/core/http/router";
import { paymentMethodsService as svc } from "./payment-methods.service";

type Id = { id: string };

export const paymentMethodsController = {
  list: ({ customerId }: Ctx) => svc.list(customerId),
  add: ({ customerId, body }: Ctx<{ returnUrl?: string | null }>) => svc.startAdd(customerId, body.returnUrl),
  update: ({ customerId, params, body }: Ctx<{ nickname?: string | null; isDefault?: boolean }, unknown, Id>) => svc.update(customerId, params.id, body),
  remove: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.remove(customerId, params.id),
};
