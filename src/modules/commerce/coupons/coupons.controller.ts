import type { Ctx } from "@/core/http/router";
import { couponsService as svc } from "./coupons.service";
import type { CouponBody, CouponListQuery, CouponPatch } from "./coupons.schemas";

type Id = { id: string };

export const couponsController = {
  mine: ({ customerId }: Ctx) => svc.mine(customerId),

  list: ({ query }: Ctx<unknown, CouponListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: ({ body }: Ctx<CouponBody>) => svc.create(body),
  update: async ({ params, body, res }: Ctx<CouponPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated coupon ${r.after.code}` };
    return r.after;
  },
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  setStatus: ({ params, body }: Ctx<{ status: CouponBody["status"] }, unknown, Id>) => svc.setStatus(params.id, body.status),
  togglePin: ({ params }: Ctx<unknown, unknown, Id>) => svc.togglePin(params.id),
  remove: ({ params }: Ctx<unknown, unknown, Id>) => svc.remove(params.id),
  redemptions: ({ params, query }: Ctx<unknown, { page: number; pageSize: number }, Id>) => svc.redemptions(params.id, query),
};
