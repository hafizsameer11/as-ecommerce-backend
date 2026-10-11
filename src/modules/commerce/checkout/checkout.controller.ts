import type { Ctx } from "@/core/http/router";
import { cartOwner } from "@/modules/commerce/carts/carts.controller";
import { checkoutService as svc } from "./checkout.service";
import type { PlaceOrderBody, UpdateCheckoutBody } from "./checkout.schemas";

const who = (ctx: Ctx) => ({ owner: cartOwner(ctx.req), customerId: ctx.req.customer?.id });

export const checkoutController = {
  get: (ctx: Ctx) => {
    const { owner, customerId } = who(ctx);
    return svc.get(owner, customerId);
  },
  update: (ctx: Ctx<UpdateCheckoutBody>) => {
    const { owner, customerId } = who(ctx);
    return svc.update(owner, customerId, ctx.body);
  },
  applyCoupon: (ctx: Ctx<{ code: string }>) => {
    const { owner, customerId } = who(ctx);
    return svc.applyCoupon(owner, customerId, ctx.body.code);
  },
  removeCoupon: (ctx: Ctx) => {
    const { owner, customerId } = who(ctx);
    return svc.removeCoupon(owner, customerId);
  },
  placeOrder: (ctx: Ctx<PlaceOrderBody>) => {
    const { owner, customerId } = who(ctx);
    return svc.placeOrder(owner, customerId, ctx.body);
  },
};
