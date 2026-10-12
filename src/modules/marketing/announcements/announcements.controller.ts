import type { Ctx } from "@/core/http/router";
import { announcementsService as svc } from "./announcements.service";
import type { AnnouncementBody, AnnouncementListQuery, AnnouncementPatch, AnnouncementStatusBody, StoreAnnouncementsQuery } from "./announcements.schemas";

type Id = { id: string };

export const announcementsController = {
  storeList: ({ query, req }: Ctx<unknown, StoreAnnouncementsQuery>) => svc.storeList(query, req.customer?.id),
  adminBar: () => svc.adminBar(),

  list: ({ query }: Ctx<unknown, AnnouncementListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<AnnouncementBody>) => {
    const a = await svc.create(body);
    res.locals.audit = { entityId: a.id, after: a, summary: `Created announcement ${a.title}` };
    return a;
  },
  update: async ({ params, body, res }: Ctx<AnnouncementPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated announcement ${r.after.title}` };
    return r.after;
  },
  setStatus: async ({ params, body, res }: Ctx<AnnouncementStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body.status);
    res.locals.audit = { before: { status: r.before.status }, after: { status: r.after.status }, summary: `Announcement ${r.after.title} → ${r.after.status}` };
    return r.after;
  },
  duplicate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const a = await svc.duplicate(params.id);
    res.locals.audit = { entityId: a.id, summary: `Duplicated announcement as ${a.title}` };
    return a;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const a = await svc.remove(params.id);
    res.locals.audit = { before: a, summary: `Deleted announcement ${a.title}` };
    return { deleted: true };
  },
};
