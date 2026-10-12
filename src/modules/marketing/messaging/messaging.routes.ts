import { ModuleRouter, idParam } from "@/core/http/router";
import { messagingController as c } from "./messaging.controller";
import * as s from "./messaging.schemas";

const audit = (action: string, entity = "message_template") => ({ category: "marketing", action, entity });

/** asl-admin /messaging: transactional templates + push blasts */
export const messagingAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/messaging", tag: "Messaging", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/templates", { summary: "Templates (filters channel / category / status, tabs, sent counts)", query: s.templateListQuery }, c.listTemplates)
  .get("/templates/:id", { summary: "Template", params: idParam }, c.getTemplate)
  .patch("/templates/:id", { summary: "Edit subject, preheader, body ({{variables}}), CTA, link, status", params: idParam, body: s.templatePatch, audit: audit("template.updated") }, c.updateTemplate)
  .patch("/templates/:id/status", { summary: "Activate / pause / draft (paused and draft templates are not sent)", params: idParam, body: s.templateStatusBody, audit: audit("template.status_changed") }, c.setTemplateStatus)
  .post("/templates/:id/duplicate", { summary: "Duplicate as a draft (code gets .copy)", params: idParam, status: 201, audit: audit("template.duplicated") }, c.duplicateTemplate)
  .post("/templates/:id/reset", { summary: "Reset to the built-in default text", params: idParam, audit: audit("template.reset") }, c.resetTemplate)
  .post("/templates/:id/preview", { summary: "Render with sample data (lists the template's variables; pass `draft` to preview unsaved edits)", params: idParam, body: s.previewBody }, c.previewTemplate)
  .post("/templates/:id/test", { summary: "Send a test: email to you (or `to`), SMS to `to`, push to a test device", params: idParam, body: s.testSendBody }, c.testTemplate)
  .delete("/templates/:id", { summary: "Delete a copied template (built-in ones can only be paused)", params: idParam, audit: audit("template.deleted") }, c.removeTemplate)
  .get("/blasts", { summary: "Push blasts (tabs, recipients / opens)", query: s.blastListQuery }, c.listBlasts)
  .get("/blasts/:id", { summary: "Push blast (with current audience size)", params: idParam }, c.getBlast)
  .post("/blasts", { summary: "Create push blast (draft or scheduled)", body: s.blastBody, status: 201, audit: audit("push_blast.created", "push_blast") }, c.createBlast)
  .patch("/blasts/:id", { summary: "Edit a draft / scheduled blast", params: idParam, body: s.blastPatch, audit: audit("push_blast.updated", "push_blast") }, c.updateBlast)
  .post("/blasts/:id/schedule", { summary: "Schedule", params: idParam, body: s.scheduleBody, audit: audit("push_blast.scheduled", "push_blast") }, c.scheduleBlast)
  .post("/blasts/:id/unschedule", { summary: "Back to draft", params: idParam, audit: audit("push_blast.unscheduled", "push_blast") }, c.unscheduleBlast)
  .post("/blasts/:id/send-now", { summary: "Send now (customers with push tokens, in batches)", params: idParam, audit: audit("push_blast.sent", "push_blast") }, c.sendBlastNow)
  .delete("/blasts/:id", { summary: "Delete push blast", params: idParam, audit: audit("push_blast.deleted", "push_blast") }, c.removeBlast);

/** the apps report a tap on a blast notification (push data has `blastId`) */
export const pushOpensStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/push", tag: "Messaging", defaultAuth: "optionalCustomer" })
  .post("/opened", { summary: "Count a push blast open", body: s.pushOpenedBody }, c.pushOpened);
