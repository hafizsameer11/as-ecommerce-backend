import type { Ctx } from "@/core/http/router";
import { shippingZonesService as svc } from "./shipping-zones.service";
import type { QuoteQuery, RateBody, ZoneBody } from "./shipping-zones.schemas";

type Id = { id: string };

export const shippingZonesController = {
  quote: ({ query }: Ctx<unknown, QuoteQuery>) => svc.quote(query),
  table: () => svc.table(),

  list: () => svc.list(),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: ({ body }: Ctx<ZoneBody>) => svc.create(body),
  update: async ({ params, body, res }: Ctx<Partial<ZoneBody>, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated shipping zone ${r.after.name}` };
    return r.after;
  },
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  toggle: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggle(params.id),
  remove: ({ params }: Ctx<unknown, unknown, Id>) => svc.remove(params.id),
  addRate: ({ params, body }: Ctx<RateBody, unknown, Id>) => svc.upsertRate(params.id, null, body),
  updateRate: ({ params, body }: Ctx<RateBody, unknown, Id & { rateId: string }>) => svc.upsertRate(params.id, params.rateId, body),
  removeRate: ({ params }: Ctx<unknown, unknown, Id & { rateId: string }>) => svc.removeRate(params.id, params.rateId),
};
