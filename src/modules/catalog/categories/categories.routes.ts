import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { categoriesService as svc } from "./categories.service";

export const categoriesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/categories", tag: "Categories" })
  .get("/", { summary: "Category tree with item counts (+ virtual Sale)" }, () => svc.storeList())
  .get("/:id", { summary: "One category by handle", params: idParam }, ({ params }) => svc.storeGet(params.id));

const status = z.enum(["active", "hidden", "draft"]);
const audit = (action: string) => ({ category: "catalog", action, entity: "category" });

/** asl-admin /categories */
export const categoriesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/categories", tag: "Categories", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "All categories incl. hidden/draft", permission: "catalog.view" }, () => svc.adminList())
  .post("/", { summary: "Add category", body: z.object({ name: z.string().trim().min(1).max(80) }), status: 201, audit: audit("category.created") }, ({ body }) => svc.create(body.name))
  .patch("/:id", {
    summary: "Update category (name, status, featured, image, SEO)",
    params: idParam,
    body: z.object({
      name: z.string().min(1).max(80).optional(), handle: z.string().max(80).optional(), description: z.string().max(2000).nullable().optional(),
      image: z.string().max(1024).nullable().optional(), icon: z.string().max(60).nullable().optional(), featured: z.boolean().optional(),
      status: status.optional(), concierge: z.boolean().optional(), seoTitle: z.string().max(190).nullable().optional(), seoDescription: z.string().max(500).nullable().optional(),
    }),
    audit: audit("category.updated"),
  }, async ({ params, body, res }) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated category ${r.after.name}` };
    return r.after;
  })
  .post("/:id/move", { summary: "Reorder up/down", params: idParam, body: z.object({ dir: z.enum(["up", "down"]) }), audit: audit("category.moved") }, ({ params, body }) => svc.move(params.id, body.dir))
  .delete("/:id", { summary: "Delete (only when empty)", params: idParam, audit: audit("category.deleted") }, async ({ params }) => {
    await svc.remove(params.id);
    return { deleted: true };
  })
  .post("/:id/subcategories", { summary: "Add subcategory", params: idParam, body: z.object({ name: z.string().trim().min(1).max(80) }), audit: audit("subcategory.created") },
    ({ params, body }) => svc.addSub(params.id, body.name))
  .patch("/:id/subcategories/:subId", {
    summary: "Update subcategory (name / status / image)",
    params: z.object({ id: z.string(), subId: z.string() }),
    body: z.object({ name: z.string().min(1).max(80).optional(), status: status.optional(), image: z.string().max(1024).nullable().optional() }),
    audit: audit("subcategory.updated"),
  }, ({ params, body }) => svc.updateSub(params.id, params.subId, body))
  .delete("/:id/subcategories/:subId", { summary: "Remove subcategory", params: z.object({ id: z.string(), subId: z.string() }), audit: audit("subcategory.deleted") },
    ({ params }) => svc.removeSub(params.id, params.subId));
