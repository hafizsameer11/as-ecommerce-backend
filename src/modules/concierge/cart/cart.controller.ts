import type { Ctx } from "@/core/http/router";
import { cartService as svc } from "./cart.service";
import type { UpdateItemBody } from "./cart.schemas";

type Id = { id: string };

export const cartController = {
  updateItem: ({ customerId, params, body }: Ctx<UpdateItemBody, unknown, Id>) => svc.updateItem(customerId, params.id, body),
  removeItem: ({ customerId, params, body }: Ctx<{ reason?: string } | undefined, unknown, Id>) => svc.removeItem(customerId, params.id, body?.reason),
  clear: ({ customerId }: Ctx) => svc.clear(customerId),
};