import { ModuleRouter, idParam } from "@/core/http/router";
import { suppliersController as c } from "./suppliers.controller";
import { supplierBody, supplierPatch, suppliersQuery } from "./suppliers.schemas";

const audit = (action: string) => ({ category: "concierge", action, entity: "supplier" });

/** asl-admin /concierge/suppliers */
export const suppliersAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/concierge/suppliers", tag: "Suppliers", defaultAuth: "admin", defaultPermission: "concierge.view" })
  .get("/", { summary: "Suppliers (status tabs, tier / country / VIP filters, KPIs)", query: suppliersQuery }, c.list)
  .get("/export", { summary: "Suppliers CSV", query: suppliersQuery }, c.exportCsv)
  .get("/:id", { summary: "Supplier + stats from linked requests", params: idParam }, c.get)
  .post("/", { summary: "Add supplier", permission: "concierge.assign", body: supplierBody, status: 201, audit: audit("supplier.created") }, c.create)
  .patch("/:id", { summary: "Update supplier (notes, status, tier …)", permission: "concierge.assign", params: idParam, body: supplierPatch, audit: audit("supplier.updated") }, c.update)
  .post("/:id/vip", { summary: "Toggle VIP partner", permission: "concierge.assign", params: idParam, audit: audit("supplier.vip_toggled") }, c.toggleVip)
  .delete("/:id", { summary: "Delete (refused while open requests use it)", permission: "concierge.assign", params: idParam, audit: audit("supplier.deleted") }, c.remove);
