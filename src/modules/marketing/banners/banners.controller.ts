import type { Ctx } from "@/core/http/router";
import { bannersService as svc } from "./banners.service";
import type { BannerBody, BannerListQuery, BannerPatch, BannerReorderBody, BannerStatusBody, MoveBody, StoreBannersQuery } from "./banners.schemas";

type Id = { id: string };

export const bannersController = {
  storeList: ({ query, req }: Ctx<unknown, StoreBannersQuery>) => svc.storeList(query, req.customer?.id),

  list: ({ query }: Ctx<unknown, BannerListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<BannerBody>) => {
    const b = await svc.create(body);
    res.locals.audit = { entityId: b.id, after: b, summary: `Created banner ${b.name} (${b.placement})` };
    return b;
  },
  update: async ({ params, body, res }: Ctx<BannerPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated banner ${r.after.name}` };
    return r.after;
  },
  setStatus: async ({ params, body, res }: Ctx<BannerStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body.status);
    res.locals.audit = { before: { status: r.before.status }, after: { status: r.after.status }, summary: `Banner ${r.after.name} → ${r.after.status}` };
    return r.after;
  },
  duplicate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const b = await svc.duplicate(params.id);
    res.locals.audit = { entityId: b.id, summary: `Duplicated banner as ${b.name}` };
    return b;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const b = await svc.remove(params.id);
    res.locals.audit = { before: b, summary: `Deleted banner ${b.name}` };
    return { deleted: true };
  },
  reorder: async ({ body, res }: Ctx<BannerReorderBody>) => {
    const rows = await svc.reorder(body.placement, body.ids);
    res.locals.audit = { summary: `Reordered ${body.placement} banners` };
    return rows;
  },
  move: async ({ params, body, res }: Ctx<MoveBody, unknown, Id>) => {
    const rows = await svc.move(params.id, body.direction);
    res.locals.audit = { summary: `Moved banner ${body.direction}` };
    return rows;
  },
};
