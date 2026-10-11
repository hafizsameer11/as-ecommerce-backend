import type { Ctx } from "@/core/http/router";
import { sizeGuidesService as svc } from "./size-guides.service";
import type { SizeGuideBody, SizeGuideQuery } from "./size-guides.schemas";

type Id = { id: string };

export const sizeGuidesController = {
  forProduct: ({ query }: Ctx<unknown, SizeGuideQuery>) => svc.forProduct(query),

  list: () => svc.list(),
  save: ({ body }: Ctx<SizeGuideBody>) => svc.save(body),
  remove: async ({ params }: Ctx<unknown, unknown, Id>) => {
    await svc.remove(params.id);
    return { deleted: true };
  },
};
