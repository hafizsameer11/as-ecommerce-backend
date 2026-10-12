import type { Ctx } from "@/core/http/router";
import { tokenList } from "../content.common";
import { pagesService as svc } from "./pages.service";
import type { BlockAdd, BlockMove, PageCreate, PageListQuery, PagePatch, PageStatusBody } from "./pages.schemas";

type Id = { id: string };
type BlockP = { id: string; blockId: string };

export const pagesController = {
  /* store */
  bySlug: ({ params, req }: Ctx<unknown, unknown, { slug: string }>) => svc.getPublished(params.slug, req.customer?.id),
  navigation: () => svc.navigation(),

  /* admin */
  list: ({ query }: Ctx<unknown, PageListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  preview: ({ params }: Ctx<unknown, unknown, Id>) => svc.preview(params.id),
  tokens: () => tokenList(),
  create: async ({ body, admin, res }: Ctx<PageCreate>) => {
    const p = await svc.create(body, admin.name);
    res.locals.audit = { entityId: p.id, after: p, summary: `Created page ${p.path}` };
    return p;
  },
  update: async ({ params, body, res }: Ctx<PagePatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated page ${r.after.path}` };
    return r.after;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { summary: `Deleted page /${r.slug}` };
    return r;
  },
  duplicate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const p = await svc.duplicate(params.id);
    res.locals.audit = { entityId: p.id, summary: `Duplicated page as ${p.path}` };
    return p;
  },
  setStatus: async ({ params, body, res }: Ctx<PageStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body);
    res.locals.audit = { before: { status: r.before.status }, after: { status: r.after.status, scheduledFor: r.after.scheduledFor }, summary: `Page ${r.after.path} → ${r.after.status}` };
    return r.after;
  },
  addBlock: ({ params, body }: Ctx<BlockAdd, unknown, Id>) => svc.addBlock(params.id, body),
  updateBlock: ({ params, body }: Ctx<Record<string, unknown>, unknown, BlockP>) => svc.updateBlock(params.id, params.blockId, body),
  removeBlock: ({ params }: Ctx<unknown, unknown, BlockP>) => svc.removeBlock(params.id, params.blockId),
  moveBlock: ({ params, body }: Ctx<BlockMove, unknown, BlockP>) => svc.moveBlock(params.id, params.blockId, body),
};
