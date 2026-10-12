import { ModuleRouter, idParam } from "@/core/http/router";
import { taxController as c } from "./tax.controller";
import { exemptionBody, taxCategoryBody, taxRateBody } from "./tax.schemas";
import { patchOf } from "@/core/http/patch-schema";

const audit = (action: string, entity = "tax_rate") => ({ category: "settings", action, entity });

/** asl-admin /tax. Tax settings (prices include tax, invoice prefix…) are `PATCH /admin/settings/tax`. */
export const taxAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/tax", tag: "Tax", defaultAuth: "admin", defaultPermission: "settings.manage" })
  .get("/", { summary: "Rates, exemptions, categories and tax settings", permission: ["finance.view"] }, c.overview)
  .post("/rates", { summary: "Add tax rate", body: taxRateBody, status: 201, audit: audit("tax_rate.created") }, c.createRate)
  .patch("/rates/:id", { summary: "Update tax rate", params: idParam, body: patchOf(taxRateBody), audit: audit("tax_rate.updated") }, c.updateRate)
  .post("/rates/:id/toggle", { summary: "Enable / disable rate", params: idParam, audit: audit("tax_rate.toggled") }, c.toggleRate)
  .delete("/rates/:id", { summary: "Delete rate", params: idParam, audit: audit("tax_rate.deleted") }, c.removeRate)
  .post("/exemptions", { summary: "Add exemption", body: exemptionBody, status: 201, audit: audit("tax_exemption.created", "tax_exemption") }, c.addExemption)
  .delete("/exemptions/:id", { summary: "Remove exemption", params: idParam, audit: audit("tax_exemption.deleted", "tax_exemption") }, c.removeExemption)
  .post("/categories", { summary: "Add tax category", body: taxCategoryBody, status: 201, audit: audit("tax_category.created", "tax_category") }, c.createCategory)
  .patch("/categories/:id", { summary: "Update tax category", params: idParam, body: patchOf(taxCategoryBody), audit: audit("tax_category.updated", "tax_category") }, c.updateCategory);
