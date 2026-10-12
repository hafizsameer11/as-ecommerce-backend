import type { Ctx } from "@/core/http/router";
import { slotsService as svc } from "./slots.service";
import type { MoveBody } from "../banners/banners.schemas";
import type { SlotBody, SlotImageBody, SlotListQuery, SlotPatch, SlotReorderBody, SlotStatusBody, StoreSlotsQuery } from "./slots.schemas";

type Id = { id: string };

export const slotsController = {
  storeList: ({ query, req }: Ctx<unknown, StoreSlotsQuery>) => svc.storeList(query, req.customer?.id),

  list: ({ query }: Ctx<unknown, SlotListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<SlotBody>) => {
    const s = await svc.create(body);
    res.locals.audit = { entityId: s.id, after: s, summary: `Created ${s.page} slot ${s.name}` };
    return s;
  },
  update: async ({ params, body, res }: Ctx<SlotPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated slot ${r.after.name}` };
    return r.after;
  },
  uploadImage: async ({ params, body, files, admin, res }: Ctx<SlotImageBody, unknown, Id>) => {
    const r = await svc.uploadImage(params.id, files[0], body.folder, `admin:${admin.id}`, body.altText);
    res.locals.audit = { before: { imageUrl: r.before.imageUrl }, after: { imageUrl: r.after.imageUrl }, summary: `New image for slot ${r.after.name}` };
    return { ...r.after, asset: r.asset };
  },
  setStatus: async ({ params, body, res }: Ctx<SlotStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body.status);
    res.locals.audit = { before: { status: r.before.status }, after: { status: r.after.status }, summary: `Slot ${r.after.name} → ${r.after.status}` };
    return r.after;
  },
  togglePin: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.togglePin(params.id);
    res.locals.audit = { summary: `${s.pinned ? "Pinned" : "Unpinned"} slot ${s.name}` };
    return s;
  },
  duplicate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.duplicate(params.id);
    res.locals.audit = { entityId: s.id, summary: `Duplicated slot as ${s.name}` };
    return s;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.remove(params.id);
    res.locals.audit = { before: s, summary: `Deleted slot ${s.name}` };
    return { deleted: true };
  },
  reorder: async ({ body, res }: Ctx<SlotReorderBody>) => {
    const rows = await svc.reorder(body.page, body.ids);
    res.locals.audit = { summary: `Reordered ${body.page} slots` };
    return rows;
  },
  move: async ({ params, body, res }: Ctx<MoveBody, unknown, Id>) => {
    const rows = await svc.move(params.id, body.direction);
    res.locals.audit = { summary: `Moved slot ${body.direction}` };
    return rows;
  },
};
