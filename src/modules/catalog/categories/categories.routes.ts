import { ModuleRouter, idParam } from "@/core/http/router";
import { categoriesController as c } from "./categories.controller";
import { categoryPatch, moveBody, nameBody, subParams, subcategoryPatch } from "./categories.schemas";

export const categoriesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/categories", tag: "Categories" })
  .get("/", { summary: "Category tree with item counts (+ virtual Sale)" }, c.storeList)
  .get("/:id", { summary: "One category by handle", params: idParam }, c.storeGet);

const audit = (action: string) => ({ category: "catalog", action, entity: "category" });

/** asl-admin /categories */
export const categoriesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/categories", tag: "Categories", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "All categories incl. hidden/draft", permission: "catalog.view" }, c.adminList)
  .post("/", { summary: "Add category", body: nameBody, status: 201, audit: audit("category.created") }, c.create)
  .patch("/:id", { summary: "Update category (name, status, featured, image, SEO)", params: idParam, body: categoryPatch, audit: audit("category.updated") }, c.update)
  .post("/:id/move", { summary: "Reorder up/down", params: idParam, body: moveBody, audit: audit("category.moved") }, c.move)
  .delete("/:id", { summary: "Delete (only when empty)", params: idParam, audit: audit("category.deleted") }, c.remove)
  .post("/:id/subcategories", { summary: "Add subcategory", params: idParam, body: nameBody, audit: audit("subcategory.created") }, c.addSub)
  .patch("/:id/subcategories/:subId", { summary: "Update subcategory (name / status / image)", params: subParams, body: subcategoryPatch, audit: audit("subcategory.updated") }, c.updateSub)
  .delete("/:id/subcategories/:subId", { summary: "Remove subcategory", params: subParams, audit: audit("subcategory.deleted") }, c.removeSub);
