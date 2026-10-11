import { ModuleRouter, idParam } from "@/core/http/router";
import { draftOrdersController as c } from "./draft-orders.controller";
import { convertDraftBody, createDraftBody, draftListQuery, payDraftBody, payTokenParam, sendDraftBody, updateDraftBody } from "./draft-orders.schemas";

const audit = (action: string, category = "orders") => ({ category, action, entity: "draft_order" });

/** asl-admin /drafts */
export const draftOrdersAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/draft-orders", tag: "Draft orders", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .get("/", { summary: "Drafts table (tabs Draft / Sent to customer / Converted, KPIs)", permission: "orders.view", query: draftListQuery }, c.list)
  .post("/", { summary: "New draft (catalogue products and/or custom lines)", body: createDraftBody, status: 201, audit: audit("draft.created") }, c.create)
  .get("/:id", { summary: "Draft detail (id or DFT- number)", permission: "orders.view", params: idParam }, c.get)
  .patch("/:id", { summary: "Edit (draft / sent only)", params: idParam, body: updateDraftBody, audit: audit("draft.updated") }, c.update)
  .delete("/:id", { summary: "Delete (not converted)", params: idParam, audit: audit("draft.deleted") }, c.remove)
  .post("/:id/duplicate", { summary: "Duplicate as a new draft", params: idParam, status: 201, audit: audit("draft.duplicated") }, c.duplicate)
  .post("/:id/send", { summary: "Email the customer a pay link (valid 7 days)", params: idParam, body: sendDraftBody, audit: audit("draft.sent") }, c.send)
  .post("/:id/convert", { summary: "Customer paid offline → create the paid order", params: idParam, body: convertDraftBody, audit: audit("draft.converted", "finance") }, c.convert);

/** web /pay/:token — the link in the email */
export const draftPayStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/pay", tag: "Draft orders" })
  .get("/:token", { summary: "What the pay link is for (404 when expired or already paid)", params: payTokenParam }, c.payView)
  .post("/:token", { summary: "Open the payment page for this draft", params: payTokenParam, body: payDraftBody, idempotent: "draft.pay" }, c.pay);
