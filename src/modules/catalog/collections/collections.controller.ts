import type { Ctx } from "@/core/http/router";
import { collectionsService as svc } from "./collections.service";
import type { CollectionAdminQuery, CollectionBody, CollectionPatch, CollectionSlotQuery } from "./collections.schemas";

type Id = { id: string };

export const collectionsController = {
  // store
  bySlot: ({ query }: Ctx<unknown, CollectionSlotQuery>) => svc.bySlot(query.slot),
  storeGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.storeGet(params.id),

  // admin
  adminList: ({ query }: Ctx<unknown, CollectionAdminQuery>) => svc.adminList(query),
  adminGet: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  preview: ({ params }: Ctx<unknown, unknown, Id>) => svc.preview(params.id),
  create: ({ body }: Ctx<CollectionBody>) => svc.create(body),
  update: async ({ params, body, res }: Ctx<CollectionPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated collection ${r.after.title}` };
    return r.after;
  },
  duplicate: ({ params }: Ctx<unknown, unknown, Id>) => svc.duplicate(params.id),
  remove: async ({ params }: Ctx<unknown, unknown, Id>) => {
    await svc.remove(params.id);
    return { deleted: true };
  },
};
