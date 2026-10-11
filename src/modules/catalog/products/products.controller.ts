import { withMeta, type Ctx } from "@/core/http/router";
import { productsService as svc } from "./products.service";
import type { AdminListQuery, AlsoLikeQuery, BulkBody, ProductInput, ProductPatch, ProductStatusBody, RelatedQuery, StoreListQuery } from "./products.schemas";

type Id = { id: string };

export const productsController = {
  // store
  list: async ({ query }: Ctx<unknown, StoreListQuery>) => {
    const r = await svc.list(query);
    return withMeta(r.items, r.meta);
  },
  facets: ({ query }: Ctx<unknown, StoreListQuery>) => svc.facets(query),
  alsoLike: ({ query }: Ctx<unknown, AlsoLikeQuery>) => svc.alsoLike(query.exclude?.split(",").filter(Boolean) ?? [], query.limit),
  detail: ({ params }: Ctx<unknown, unknown, Id>) => svc.detail(params.id),
  related: ({ params, query }: Ctx<unknown, RelatedQuery, Id>) => svc.related(params.id, query.limit),

  // admin
  adminList: async ({ query }: Ctx<unknown, AdminListQuery>) => {
    const r = await svc.adminList(query);
    return withMeta(r.items, r.meta);
  },
  adminGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  create: async ({ body, res }: Ctx<ProductInput>) => {
    const p = await svc.create(body);
    res.locals.audit = { entityId: p.productId, summary: `Created ${p.brand} ${p.name}`, after: p };
    return p;
  },
  update: async ({ params, body, res }: Ctx<ProductPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.productId, summary: `Updated ${r.after.brand} ${r.after.name}`, before: r.before, after: r.after };
    return r.after;
  },
  setStatus: ({ params, body }: Ctx<ProductStatusBody, unknown, Id>) => svc.setStatus(params.id, body.status),
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const p = await svc.remove(params.id);
    res.locals.audit = { entityId: p.productId, summary: `Deleted ${p.brand} ${p.name}`, before: p };
    return { deleted: true };
  },
  bulk: ({ body }: Ctx<BulkBody>) => svc.bulk(body),
};
