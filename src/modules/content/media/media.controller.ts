import type { Ctx } from "@/core/http/router";
import { mediaService as svc } from "./media.service";
import type { MediaListQueryIn, MediaPatchBody, UploadBody } from "./media.schemas";

type Id = { id: string };

export const mediaController = {
  list: ({ query }: Ctx<unknown, MediaListQueryIn>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  upload: async ({ files, body, admin, res }: Ctx<UploadBody>) => {
    const out = await svc.uploadMany(
      files.map((f) => ({ buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype, size: f.size })),
      body.folder, admin.name, body.altText, body.tags,
    );
    res.locals.audit = { entityId: out[0]?.id, summary: `Uploaded ${out.length} file(s) to ${body.folder}` };
    return out;
  },
  update: async ({ params, body, res }: Ctx<MediaPatchBody, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated file ${r.after.name}` };
    return r.after;
  },
  star: ({ params }: Ctx<unknown, unknown, Id>) => svc.toggleStar(params.id),
  move: async ({ body, res }: Ctx<{ ids: string[]; folder: string }>) => {
    const r = await svc.move(body.ids, body.folder);
    res.locals.audit = { summary: `Moved ${r.moved} file(s) to ${r.folder}` };
    return r;
  },
  remove: async ({ params, query, res }: Ctx<unknown, { force: boolean }, Id>) => {
    const a = await svc.get(params.id);
    await svc.remove(params.id, query.force);
    res.locals.audit = { summary: `Deleted file ${a.name}${a.usedIn.length ? ` (was used in ${a.usedIn.length} place(s))` : ""}`, before: a };
    return { id: params.id, deleted: true };
  },
  bulkRemove: async ({ body, res }: Ctx<{ ids: string[]; force: boolean }>) => {
    const r = await svc.bulkRemove(body.ids, body.force);
    res.locals.audit = { summary: `Deleted ${r.deleted} file(s)${body.force ? " (forced)" : ""}` };
    return r;
  },
};
