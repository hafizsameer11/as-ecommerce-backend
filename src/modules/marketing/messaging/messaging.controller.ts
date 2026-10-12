import type { Ctx } from "@/core/http/router";
import { templatesService as tpl } from "./templates.service";
import { blastsService as blasts } from "./blasts.service";
import type { BlastBody, BlastListQuery, BlastPatch, PreviewBody, TemplateListQuery, TemplatePatch, TestSendBody } from "./messaging.schemas";

type Id = { id: string };

export const messagingController = {
  // ── templates ──
  listTemplates: ({ query }: Ctx<unknown, TemplateListQuery>) => tpl.list(query),
  getTemplate: ({ params }: Ctx<unknown, unknown, Id>) => tpl.get(params.id),
  updateTemplate: async ({ params, body, res }: Ctx<TemplatePatch, unknown, Id>) => {
    const r = await tpl.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Edited template ${r.after.code} (${r.after.channel})` };
    return r.after;
  },
  setTemplateStatus: async ({ params, body, res }: Ctx<{ status: "active" | "draft" | "paused" }, unknown, Id>) => {
    const t = await tpl.setStatus(params.id, body.status);
    res.locals.audit = { after: { status: t.status }, summary: `Template ${t.code} (${t.channel}) → ${t.status}` };
    return t;
  },
  duplicateTemplate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const t = await tpl.duplicate(params.id);
    res.locals.audit = { entityId: t.id, summary: `Duplicated template as ${t.code}` };
    return t;
  },
  removeTemplate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await tpl.remove(params.id);
    res.locals.audit = { summary: `Deleted template ${r.code}` };
    return { deleted: true };
  },
  resetTemplate: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await tpl.reset(params.id);
    res.locals.audit = { before: r.before, after: r.after, summary: `Reset template ${r.after.code} (${r.after.channel}) to default` };
    return r.after;
  },
  previewTemplate: ({ params, body }: Ctx<PreviewBody, unknown, Id>) => tpl.preview(params.id, body),
  testTemplate: ({ params, body, admin }: Ctx<TestSendBody, unknown, Id>) => tpl.test(params.id, body, admin),

  // ── push blasts ──
  listBlasts: ({ query }: Ctx<unknown, BlastListQuery>) => blasts.list(query),
  getBlast: ({ params }: Ctx<unknown, unknown, Id>) => blasts.get(params.id),
  createBlast: async ({ body, res }: Ctx<BlastBody>) => {
    const b = await blasts.create(body);
    res.locals.audit = { entityId: b.id, after: b, summary: `Created push blast "${b.title}"` };
    return b;
  },
  updateBlast: async ({ params, body, res }: Ctx<BlastPatch, unknown, Id>) => {
    const r = await blasts.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Edited push blast "${r.after.title}"` };
    return r.after;
  },
  scheduleBlast: async ({ params, body, res }: Ctx<{ scheduledFor: Date }, unknown, Id>) => {
    const b = await blasts.schedule(params.id, body.scheduledFor);
    res.locals.audit = { summary: `Scheduled push blast "${b.title}" for ${body.scheduledFor.toISOString()}` };
    return b;
  },
  unscheduleBlast: ({ params }: Ctx<unknown, unknown, Id>) => blasts.unschedule(params.id),
  sendBlastNow: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const b = await blasts.sendNow(params.id);
    res.locals.audit = { summary: `Sent push blast "${b.title}"` };
    return b;
  },
  removeBlast: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await blasts.remove(params.id);
    res.locals.audit = { summary: `Deleted push blast "${r.title}"` };
    return { deleted: true };
  },
  pushOpened: ({ body }: Ctx<{ blastId: string }>) => blasts.opened(body.blastId),
};
