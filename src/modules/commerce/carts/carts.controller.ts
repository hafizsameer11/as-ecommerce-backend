import type { Request } from "express";
import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { cartsService as svc, type CartOwner } from "./carts.service";
import type { AddItemBody, MergeBody, UpdateItemBody } from "./carts.schemas";

/** signed-in customer → account bag, otherwise the guest bag named by `X-Cart-Token` */
export function cartOwner(req: Request): CartOwner {
  if (req.customer?.id) return { customerId: req.customer.id };
  const t = req.header("X-Cart-Token");
  return t && /^[\w-]{20,64}$/.test(t) ? { guestToken: t } : {};
}

const channel = (req: Request) => {
  const c = req.header("X-Client");
  return c === "mobile" || c === "pwa" ? c : "web";
};

export const cartsController = {
  get: ({ req }: Ctx) => svc.get(cartOwner(req)),
  summary: ({ req }: Ctx) => svc.summary(cartOwner(req)),
  add: ({ req, body }: Ctx<AddItemBody>) => svc.add(cartOwner(req), body, channel(req)),
  update: ({ req, params, body }: Ctx<UpdateItemBody, unknown, { id: string }>) => svc.update(cartOwner(req), params.id, body),
  remove: ({ req, params }: Ctx<unknown, unknown, { id: string }>) => svc.remove(cartOwner(req), params.id),
  clear: ({ req }: Ctx) => svc.clear(cartOwner(req)),
  removeUnavailable: ({ req }: Ctx) => svc.removeUnavailable(cartOwner(req)),
  merge: ({ customerId, body }: Ctx<MergeBody>) => {
    if (!customerId) throw ApiError.unauthenticated();
    return svc.merge(customerId, body.guestToken);
  },
};
