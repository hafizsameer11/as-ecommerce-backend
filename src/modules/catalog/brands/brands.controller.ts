import type { Ctx } from "@/core/http/router";
import { brandsService as svc } from "./brands.service";
import type { BrandAdminQuery, BrandBody, BrandPatch, BrandStoreQuery, ConciergeBrandQuery } from "./brands.schemas";

type Id = { id: string };

export const brandsController = {
  // store
  storeList: ({ query }: Ctx<unknown, BrandStoreQuery>) => svc.storeList(query),
  storeGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.storeGet(params.id),
  conciergeList: ({ query }: Ctx<unknown, ConciergeBrandQuery>) => svc.storeList({ ...query, concierge: true }),

  // admin
  adminList: ({ query }: Ctx<unknown, BrandAdminQuery>) => svc.adminList(query),
  adminGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  create: ({ body }: Ctx<BrandBody>) => svc.create(body),
  update: async ({ params, body, res }: Ctx<BrandPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated brand ${r.after.name}` };
    return r.after;
  },
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  remove: async ({ params }: Ctx<unknown, unknown, Id>) => {
    await svc.remove(params.id);
    return { deleted: true };
  },
};
