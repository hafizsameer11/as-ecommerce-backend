import type { Ctx } from "@/core/http/router";
import { ingestService } from "./analytics.ingest";
import { analyticsService as svc } from "./analytics.service";
import { rollupsService } from "./analytics.rollups";
import type { CohortsQuery, ConciergeQuery, EventsBody, ProductsQuery, RebuildBody, SalesQuery, TrafficQuery } from "./analytics.schemas";

export const analyticsController = {
  ingest: ({ req, body }: Ctx<EventsBody>) =>
    ingestService.record(body, {
      customerId: req.customer?.id,
      anonId: req.anonId,
      userAgent: req.headers["user-agent"],
      country: req.header("CF-IPCountry") ?? undefined,
      channel: req.header("X-Client") ?? undefined,
    }),

  sales: ({ query }: Ctx<unknown, SalesQuery>) => svc.sales(query),
  products: ({ query }: Ctx<unknown, ProductsQuery>) => svc.products(query),
  traffic: ({ query }: Ctx<unknown, TrafficQuery>) => svc.traffic(query),
  cohorts: ({ query }: Ctx<unknown, CohortsQuery>) => svc.cohorts(query),
  concierge: ({ query }: Ctx<unknown, ConciergeQuery>) => svc.concierge(query),
  rebuild: async ({ body, res }: Ctx<RebuildBody>) => {
    const r = await rollupsService.rebuildRange(body.from, body.to);
    res.locals.audit = { summary: `Rebuilt analytics rollups ${body.from} → ${body.to}` };
    return r;
  },
};
