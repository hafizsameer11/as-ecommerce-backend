import { ModuleRouter, idParam } from "@/core/http/router";
import { segmentsController as c } from "./segments.controller";
import { rulesBody, segmentBody, segmentCustomersQuery, segmentListQuery, segmentPatch } from "./segments.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "segment" });

/** asl-admin /segments. Rules: spend/aov in kobo, lastOrderAt/createdAt in days, country as ISO code or name. */
export const segmentsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/segments", tag: "Segments", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/", { summary: "Segments (with live customer counts; ?counts=false to skip)", query: segmentListQuery }, c.list)
  .post("/preview", { summary: "Preview unsaved rules: count, marketable, spend, 20 sample customers", body: rulesBody }, c.previewRules)
  .get("/:id", { summary: "Segment", params: idParam }, c.get)
  .get("/:id/preview", { summary: "Count, share, marketable, spend + 20 sample customers", params: idParam }, c.preview)
  .get("/:id/customers", { summary: "Customers in the segment (paginated; ?marketable=true for opted-in only)", params: idParam, query: segmentCustomersQuery }, c.customers)
  .get("/:id/customers/export", { summary: "Export the segment's customers (CSV)", params: idParam, query: segmentCustomersQuery }, c.exportCsv)
  .post("/", { summary: "Create segment", body: segmentBody, status: 201, audit: audit("segment.created") }, c.create)
  .patch("/:id", { summary: "Update segment", params: idParam, body: segmentPatch, audit: audit("segment.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate segment", params: idParam, status: 201, audit: audit("segment.duplicated") }, c.duplicate)
  .post("/:id/pin", { summary: "Pin / unpin", params: idParam }, c.togglePin)
  .delete("/:id", { summary: "Delete segment (built-in ones can't be deleted)", params: idParam, audit: audit("segment.deleted") }, c.remove);
