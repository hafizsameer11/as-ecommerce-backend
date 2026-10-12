import { ModuleRouter, idParam } from "@/core/http/router";
import { reportsController as c } from "./reports.controller";
import { reportBody, reportListQuery, reportPatch, runBody, runIdParam, runListQuery, scheduleBody } from "./reports.schemas";

const audit = (action: string) => ({ category: "system", action, entity: "report" });

/** asl-admin /reports. Finance generators (VAT, wallet liabilities, inventory valuation) also need finance.view. */
export const reportsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/reports", tag: "Reports", defaultAuth: "admin", defaultPermission: "analytics.view" })
  .get("/generators", { summary: "Report types the library can use (finance ones flagged)" }, c.generators)
  // runs first: /runs/* must not match /:id
  .get("/runs", { summary: "Run log (queued / running / ready / failed)", query: runListQuery }, c.runs)
  .get("/runs/export", { summary: "Run log as CSV", query: runListQuery }, c.exportRuns)
  .get("/runs/:runId", { summary: "One run (poll until ready)", params: runIdParam }, c.getRun)
  .get("/runs/:runId/download", { summary: "Download the file of a ready run (streamed, never public)", params: runIdParam }, c.download)
  .get("/", { summary: "Report library (tabs, KPIs, search, category)", query: reportListQuery }, c.list)
  .post("/", { summary: "Save a report", body: reportBody, status: 201, audit: audit("report.created") }, c.create)
  .get("/:id", { summary: "Report", params: idParam }, c.get)
  .patch("/:id", { summary: "Update report", params: idParam, body: reportPatch, audit: audit("report.updated") }, c.update)
  .delete("/:id", { summary: "Delete report (and its files)", params: idParam, audit: audit("report.deleted") }, c.remove)
  .post("/:id/favorite", { summary: "Star / unstar", params: idParam }, c.favorite)
  .post("/:id/schedule", { summary: "Schedule (off | daily | weekly | monthly) + recipients", params: idParam, body: scheduleBody, audit: audit("report.scheduled") }, c.schedule)
  .post("/:id/run", { summary: "Run now → queued run (file built in the background)", params: idParam, body: runBody, status: 202, audit: audit("report.run") }, c.run);
