import { ModuleRouter } from "@/core/http/router";
import { draftImportController as c } from "./draft-import.controller";
import { importDraftsBody } from "./draft-import.schemas";

/** asl-admin /drafts → Import CSV. Registered before draftOrdersAdminRoutes. */
export const draftImportAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/draft-orders", tag: "Draft orders", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .get("/import/template", { summary: "Sample CSV for the import (columns + example rows)" }, c.template)
  .post("/import", {
    summary: "Import drafts from CSV → `{ created, errors: [{row, column, message}] }`",
    description:
      "Columns: customerEmail or customerName + email; sku or productHandle (+ size, color) or name (custom line); qty; unitPrice (NGN, optional for catalogue lines); note; groupKey (same key = one draft). " +
      "All rows are checked first: if any row has an error nothing is created (`created: []`). `dryRun=true` only validates.",
    upload: { field: "file", maxCount: 1, maxMB: 2, accept: /^(text\/(csv|plain|comma-separated-values)|application\/(csv|vnd\.ms-excel|octet-stream))$/ },
    body: importDraftsBody,
    audit: { category: "orders", action: "draft.imported", entity: "draft_order" },
  }, c.import);
