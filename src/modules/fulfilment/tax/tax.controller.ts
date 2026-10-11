import type { Ctx } from "@/core/http/router";
import { taxService as svc } from "./tax.service";
import type { ExemptionBody, TaxCategoryBody, TaxRateBody } from "./tax.schemas";

type Id = { id: string };

export const taxController = {
  overview: () => svc.overview(),
  createRate: ({ body }: Ctx<TaxRateBody>) => svc.createRate(body),
  updateRate: async ({ params, body, res }: Ctx<Partial<TaxRateBody>, unknown, Id>) => {
    const r = await svc.updateRate(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated tax rate ${r.after.name}` };
    return r.after;
  },
  toggleRate: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleRate(params.id),
  removeRate: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeRate(params.id),
  addExemption: ({ body }: Ctx<ExemptionBody>) => svc.addExemption(body),
  removeExemption: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeExemption(params.id),
  createCategory: ({ body }: Ctx<TaxCategoryBody>) => svc.createCategory(body),
  updateCategory: ({ params, body }: Ctx<Partial<TaxCategoryBody>, unknown, Id>) => svc.updateCategory(params.id, body),
};
