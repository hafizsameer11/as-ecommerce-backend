import type { Ctx } from "@/core/http/router";
import { cartService as svc } from "./cart.service";
import type { CheckoutBody, UpdateItemBody } from "./cart.schemas";

type Id = { id: string };

export const cartController = {
  updateItem: ({ customerId, params, body }: Ctx<UpdateItemBody, unknown, Id>) => svc.updateItem(customerId, params.id, body),
  removeItem: ({ customerId, params, body }: Ctx<{ reason?: string } | undefined, unknown, Id>) => svc.removeItem(customerId, params.id, body?.reason),
  clear: ({ customerId }: Ctx) => svc.clear(customerId),
  preview: ({ customerId, query }: Ctx<unknown, { ids?: string }>) =>
    svc.preview(customerId, query.ids ? query.ids.split(",").map((s) => s.trim()).filter(Boolean) : undefined),
  checkout: ({ customerId, body }: Ctx<CheckoutBody>) => svc.checkout(customerId, body),
  getCheckout: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.getCheckout(customerId, params.id),
};
