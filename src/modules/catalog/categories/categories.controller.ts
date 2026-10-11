import type { Ctx } from "@/core/http/router";
import { categoriesService as svc } from "./categories.service";
import type { CategoryPatch, MoveBody, NameBody, SubParams, SubcategoryPatch } from "./categories.schemas";

type Id = { id: string };

export const categoriesController = {
  // store
  storeList: () => svc.storeList(),
  storeGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.storeGet(params.id),

  // admin
  adminList: () => svc.adminList(),
  create: ({ body }: Ctx<NameBody>) => svc.create(body.name),
  update: async ({ params, body, res }: Ctx<CategoryPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated category ${r.after.name}` };
    return r.after;
  },
  move: ({ params, body }: Ctx<MoveBody, unknown, Id>) => svc.move(params.id, body.dir),
  remove: async ({ params }: Ctx<unknown, unknown, Id>) => {
    await svc.remove(params.id);
    return { deleted: true };
  },
  addSub: ({ params, body }: Ctx<NameBody, unknown, Id>) => svc.addSub(params.id, body.name),
  updateSub: ({ params, body }: Ctx<SubcategoryPatch, unknown, SubParams>) => svc.updateSub(params.id, params.subId, body),
  removeSub: ({ params }: Ctx<unknown, unknown, SubParams>) => svc.removeSub(params.id, params.subId),
};
