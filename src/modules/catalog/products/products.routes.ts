import { z } from "zod";
import { ModuleRouter, idParam, withMeta } from "@/core/http/router";
import { productsService as svc } from "./products.service";
import * as s from "./products.schemas";

/** shop, category, browse, sales, trending, best sellers, new arrivals, brand, collection, search, product page, quick view */
export const productsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/products", tag: "Products" })
  .get("/", {
    summary: "Product list with filters & sort",
    description: "category=`clothing|footwear|accessories|fragrances|sale`, brand/size/color accept comma lists. sort: " + s.SORTS.join(", "),
    query: s.storeListQuery,
  }, async ({ query }) => {
    const r = await svc.list(query);
    return withMeta(r.items, r.meta);
  })
  .get("/facets", { summary: "Filter sheet counts for the current listing", query: s.storeListQuery }, ({ query }) => svc.facets(query))
  .get("/also-like", { summary: "\"You may also like\" (excludes the given ids)", query: z.object({ exclude: z.string().optional(), limit: z.coerce.number().int().min(1).max(24).default(8) }) },
    ({ query }) => svc.alsoLike(query.exclude?.split(",").filter(Boolean) ?? [], query.limit))
  .get("/:id", { summary: "Product page (id = handle, e.g. c1)", params: idParam }, ({ params }) => svc.detail(params.id))
  .get("/:id/related", { summary: "Related products", params: idParam, query: z.object({ limit: z.coerce.number().int().min(1).max(12).default(4) }) },
    ({ params, query }) => svc.related(params.id, query.limit));

/** asl-admin /products */
export const productsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/products", tag: "Products", defaultAuth: "admin", defaultPermission: "catalog.view" })
  .get("/", { summary: "Products table (status tabs, stock state, search, sort)", query: s.adminListQuery }, async ({ query }) => {
    const r = await svc.adminList(query);
    return withMeta(r.items, r.meta);
  })
  .get("/:id", { summary: "Product editor data", params: idParam }, ({ params }) => svc.adminGet(params.id))
  .post("/", {
    summary: "Create product (variants generated from sizes × colours)",
    permission: "catalog.edit", body: s.productInput, status: 201,
    audit: { category: "catalog", action: "product.created", entity: "product" },
  }, async ({ body, res }) => {
    const p = await svc.create(body);
    res.locals.audit = { entityId: p.productId, summary: `Created ${p.brand} ${p.name}`, after: p };
    return p;
  })
  .patch("/:id", {
    summary: "Update product", permission: "catalog.edit", params: idParam, body: s.productPatch,
    audit: { category: "catalog", action: "product.updated", entity: "product" },
  }, async ({ params, body, res }) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.productId, summary: `Updated ${r.after.brand} ${r.after.name}`, before: r.before, after: r.after };
    return r.after;
  })
  .patch("/:id/status", {
    summary: "Publish / draft / archive", permission: "catalog.publish", params: idParam,
    body: z.object({ status: z.enum(["active", "draft", "archived"]) }),
    audit: { category: "catalog", action: "product.status", entity: "product" },
  }, ({ params, body }) => svc.setStatus(params.id, body.status))
  .post("/:id/duplicate", { summary: "Duplicate (as draft)", permission: "catalog.edit", params: idParam, status: 201, audit: { category: "catalog", action: "product.duplicated", entity: "product" } },
    ({ params }) => svc.duplicate(params.id))
  .delete("/:id", { summary: "Delete product (soft)", permission: "catalog.edit", params: idParam, audit: { category: "catalog", action: "product.deleted", entity: "product", severity: "notice" } },
    async ({ params, res }) => {
      const p = await svc.remove(params.id);
      res.locals.audit = { entityId: p.productId, summary: `Deleted ${p.brand} ${p.name}`, before: p };
      return { deleted: true };
    })
  .post("/bulk", { summary: "Bulk: publish, draft, archive, delete, setCategory, feature", permission: "catalog.edit", body: s.bulkSchema, audit: { category: "catalog", action: "product.bulk", entity: "product" } },
    ({ body }) => svc.bulk(body));
