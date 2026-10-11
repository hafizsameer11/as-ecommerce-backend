import { ModuleRouter, idParam } from "@/core/http/router";
import { brandsController as c } from "./brands.controller";
import { brandAdminQuery, brandBody, brandPatch, brandStoreQuery, conciergeBrandQuery } from "./brands.schemas";

export const brandsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/brands", tag: "Brands" })
  .get("/", { summary: "Brand directory (A–Z, item counts, sample image)", query: brandStoreQuery }, c.storeList)
  .get("/:id", { summary: "Brand page header (products via GET /products?brand=)", params: idParam }, c.storeGet);

export const conciergeBrandsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge/brands", tag: "Concierge" })
  .get("/", { summary: "Brands we can source (/concierge-brands)", query: conciergeBrandQuery }, c.conciergeList);

const audit = (action: string) => ({ category: "catalog", action, entity: "brand" });

/** asl-admin /brands */
export const brandsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/brands", tag: "Brands", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "Brands table", permission: "catalog.view", query: brandAdminQuery }, c.adminList)
  .get("/:id", { summary: "Brand", permission: "catalog.view", params: idParam }, c.adminGet)
  .post("/", { summary: "Create brand", body: brandBody, status: 201, audit: audit("brand.created") }, c.create)
  .patch("/:id", { summary: "Update brand (incl. status, tier, featured, concierge-only)", params: idParam, body: brandPatch, audit: audit("brand.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate brand", params: idParam, status: 201, audit: audit("brand.duplicated") }, c.duplicate)
  .delete("/:id", { summary: "Delete brand (only without products)", params: idParam, audit: audit("brand.deleted") }, c.remove);
