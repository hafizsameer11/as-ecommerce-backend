import type { Response } from "express";
import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { reportsService as svc } from "./reports.service";
import type { ReportBody, ReportListQuery, ReportPatch, RunBody, RunListQuery, ScheduleBody } from "./reports.schemas";

type Id = { id: string };
type RunId = { runId: string };

function sendFile(res: Response, f: { buffer: Buffer; filename: string; contentType: string }) {
  res.setHeader("Content-Type", f.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`);
  res.setHeader("Content-Length", String(f.buffer.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(f.buffer);
}

export const reportsController = {
  generators: ({ admin }: Ctx) => svc.generators(admin),
  list: ({ query, admin }: Ctx<unknown, ReportListQuery>) => svc.list(query, admin),
  get: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.get(params.id, admin),
  create: async ({ body, admin, res }: Ctx<ReportBody>) => {
    const r = await svc.create(body, admin);
    res.locals.audit = { entityId: r.id, summary: `Created report "${r.name}" (${r.generatorLabel})`, after: r };
    return r;
  },
  update: async ({ params, body, admin, res }: Ctx<ReportPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body, admin);
    res.locals.audit = { summary: `Updated report "${r.after.name}"`, before: r.before, after: r.after };
    return r.after;
  },
  remove: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id, admin);
    res.locals.audit = { summary: `Deleted report "${r.name}"` };
    return { deleted: true };
  },
  favorite: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.toggleFavorite(params.id, admin),
  schedule: async ({ params, body, admin, res }: Ctx<ScheduleBody, unknown, Id>) => {
    const r = await svc.setSchedule(params.id, body, admin);
    res.locals.audit = { summary: `Report "${r.name}" schedule → ${r.schedule}${r.recipients.length ? ` (${r.recipients.join(", ")})` : ""}` };
    return r;
  },
  run: async ({ params, body, admin, res }: Ctx<RunBody, unknown, Id>) => {
    const r = await svc.run(params.id, body.format, admin);
    res.locals.audit = { summary: `Ran report "${r.reportName ?? params.id}" as ${body.format.toUpperCase()}` };
    return r;
  },
  runs: ({ query, admin }: Ctx<unknown, RunListQuery>) => svc.runs(query, admin),
  exportRuns: async ({ query, admin, res }: Ctx<unknown, RunListQuery>) => sendCsv(res, "report-runs", await svc.exportRuns(query, admin)),
  getRun: ({ params, admin }: Ctx<unknown, unknown, RunId>) => svc.getRun(params.runId, admin),
  download: async ({ params, admin, res }: Ctx<unknown, unknown, RunId>) => sendFile(res, await svc.download(params.runId, admin)),
};
