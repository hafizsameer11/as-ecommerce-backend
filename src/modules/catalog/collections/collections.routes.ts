import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { collectionsService as svc } from "./collections.service";

export const collectionsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/collections", tag: "Collections" })
  .get("/", { summary: "Active collections for a slot (home rows, shop hub)", query: z.object({ slot: z.enum(["hero", "home_row_1", "home_row_2", "shop_hub"]) }) },
    ({ query }) => svc.bySlot(query.slot))
  .get("/:id", { summary: "Collection page (/collection/:slug) with products", params: idParam }, ({ params }) => svc.storeGet(params.id));

const rule = z.object({
  field: z.enum(["category", "brand", "price", "availability", "subcategory"]),
  op: z.enum(["is", "is_not", "gt", "lt", "contains"]),
  value: z.string().max(120),
});
const body = z.object({
  title: z.string().trim().min(1).max(120), handle: z.string().max(100).optional(), description: z.string().max(5000).nullable().optional(),
  status: z.enum(["active", "scheduled", "draft", "archived"]).optional(), type: z.enum(["manual", "smart"]).optional(),
  slot: z.enum(["hero", "home_row_1", "home_row_2", "shop_hub", "none"]).optional(), rules: z.array(rule).max(20).optional(),
  productIds: z.array(z.string()).max(500).optional(), coverUrl: z.string().max(1024).nullable().optional(), featured: z.boolean().optional(),
  sortOrder: z.enum(["manual", "newest", "price_asc", "price_desc", "bestseller"]).optional(), tags: z.array(z.string().max(40)).max(20).optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
});
const audit = (action: string) => ({ category: "catalog", action, entity: "collection" });

/** asl-admin /collections */
export const collectionsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/collections", tag: "Collections", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "Collections", permission: "catalog.view", query: z.object({ q: z.string().optional(), status: z.enum(["active", "scheduled", "draft", "archived"]).optional() }) },
    ({ query }) => svc.adminList(query))
  .get("/:id", { summary: "Collection", permission: "catalog.view", params: idParam }, ({ params }) => svc.adminGet(params.id))
  .get("/:id/preview", { summary: "Products this collection resolves to (smart rules)", permission: "catalog.view", params: idParam }, ({ params }) => svc.preview(params.id))
  .post("/", { summary: "Create collection", body, status: 201, audit: audit("collection.created") }, ({ body }) => svc.create(body))
  .patch("/:id", { summary: "Update collection (status, slot, featured, products, rules)", params: idParam, body: body.partial(), audit: audit("collection.updated") },
    async ({ params, body, res }) => {
      const r = await svc.update(params.id, body);
      res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated collection ${r.after.title}` };
      return r.after;
    })
  .post("/:id/duplicate", { summary: "Duplicate", params: idParam, status: 201, audit: audit("collection.duplicated") }, ({ params }) => svc.duplicate(params.id))
  .delete("/:id", { summary: "Delete", params: idParam, audit: audit("collection.deleted") }, async ({ params }) => {
    await svc.remove(params.id);
    return { deleted: true };
  });
