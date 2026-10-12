import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { segmentsService as svc } from "./segments.service";
import type { RulesBody, SegmentBody, SegmentCustomersQuery, SegmentListQuery, SegmentPatch } from "./segments.schemas";

type Id = { id: string };

export const segmentsController = {
  list: ({ query }: Ctx<unknown, SegmentListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<SegmentBody>) => {
    const s = await svc.create(body);
    res.locals.audit = { entityId: s.id, after: s, summary: `Created segment ${s.name}` };
    return s;
  },
  update: async ({ params, body, res }: Ctx<SegmentPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Updated segment ${r.after.name}` };
    return r.after;
  },
  duplicate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.duplicate(params.id);
    res.locals.audit = { entityId: s.id, summary: `Duplicated segment as ${s.name}` };
    return s;
  },
  togglePin: ({ params }: Ctx<unknown, unknown, Id>) => svc.togglePin(params.id),
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { summary: `Deleted segment ${r.name}` };
    return { deleted: true };
  },
  preview: ({ params }: Ctx<unknown, unknown, Id>) => svc.preview(params.id),
  previewRules: ({ body }: Ctx<RulesBody>) => svc.previewRules(body),
  customers: ({ params, query }: Ctx<unknown, SegmentCustomersQuery, Id>) => svc.customers(params.id, query),
  exportCsv: async ({ params, query, res }: Ctx<unknown, SegmentCustomersQuery, Id>) => {
    const r = await svc.exportCsv(params.id, query);
    sendCsv(res, r.name, r.csv);
  },
};
