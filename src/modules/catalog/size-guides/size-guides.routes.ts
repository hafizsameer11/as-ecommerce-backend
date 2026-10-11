import { ModuleRouter, idParam } from "@/core/http/router";
import { sizeGuidesController as c } from "./size-guides.controller";
import { sizeGuideBody, sizeGuideQuery } from "./size-guides.schemas";

export const sizeGuidesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/size-guides", tag: "Size guides" })
  .get("/", { summary: "Size guide notes for a product (brand guide wins over category guide)", query: sizeGuideQuery }, c.forProduct);

/** asl-admin /size-guides */
export const sizeGuidesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/size-guides", tag: "Size guides", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "All size guides", permission: "catalog.view" }, c.list)
  .put("/", { summary: "Create or replace the guide for a brand/category", body: sizeGuideBody, audit: { category: "catalog", action: "size_guide.saved", entity: "size_guide" } }, c.save)
  .delete("/:id", { summary: "Delete a size guide", params: idParam, audit: { category: "catalog", action: "size_guide.deleted", entity: "size_guide" } }, c.remove);
