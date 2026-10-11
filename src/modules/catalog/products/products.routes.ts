import { ModuleRouter, idParam } from "@/core/http/router";
import { productsController as c } from "./products.controller";
import * as s from "./products.schemas";

/** shop, category, browse, sales, trending, best sellers, new arrivals, brand, collection, search, product page, quick view */
export const productsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/products", tag: "Products" })
  .get("/", {
    summary: "Product list with filters & sort",
    description: "category=`clothing|footwear|accessories|fragrances|sale`, brand/size/color accept comma lists. sort: " + s.SORTS.join(", "),
    query: s.storeListQuery,
  }, c.list)
  .get("/facets", { summary: "Filter sheet counts for the current listing", query: s.storeListQuery }, c.facets)
  .get("/also-like", { summary: "\"You may also like\" (excludes the given ids)", query: s.alsoLikeQuery }, c.alsoLike)
  .get("/:id", { summary: "Product page (id = handle, e.g. c1)", params: idParam }, c.detail)
  .get("/:id/related", { summary: "Related products", params: idParam, query: s.relatedQuery }, c.related);

/** asl-admin /products */
export const productsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/products", tag: "Products", defaultAuth: "admin", defaultPermission: "catalog.view" })
  .get("/", { summary: "Products table (status tabs, stock state, search, sort)", query: s.adminListQuery }, c.adminList)
  .get("/:id", { summary: "Product editor data", params: idParam }, c.adminGet)
  .post("/", {
    summary: "Create product (variants generated from sizes × colours)",
    permission: "catalog.edit", body: s.productInput, status: 201,
    audit: { category: "catalog", action: "product.created", entity: "product" },
  }, c.create)
  .patch("/:id", {
    summary: "Update product", permission: "catalog.edit", params: idParam, body: s.productPatch,
    audit: { category: "catalog", action: "product.updated", entity: "product" },
  }, c.update)
  .patch("/:id/status", {
    summary: "Publish / draft / archive", permission: "catalog.publish", params: idParam, body: s.productStatusBody,
    audit: { category: "catalog", action: "product.status", entity: "product" },
  }, c.setStatus)
  .post("/:id/duplicate", { summary: "Duplicate (as draft)", permission: "catalog.edit", params: idParam, status: 201, audit: { category: "catalog", action: "product.duplicated", entity: "product" } }, c.duplicate)
  .delete("/:id", { summary: "Delete product (soft)", permission: "catalog.edit", params: idParam, audit: { category: "catalog", action: "product.deleted", entity: "product", severity: "notice" } }, c.remove)
  .post("/bulk", { summary: "Bulk: publish, draft, archive, delete, setCategory, feature", permission: "catalog.edit", body: s.bulkSchema, audit: { category: "catalog", action: "product.bulk", entity: "product" } }, c.bulk);
