import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { brandsService as svc } from "./brands.service";

export const brandsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/brands", tag: "Brands" })
  .get("/", {
    summary: "Brand directory (A–Z, item counts, sample image)",
    query: z.object({ q: z.string().max(80).optional(), featured: z.coerce.boolean().optional() }),
  }, ({ query }) => svc.storeList(query))
  .get("/:id", { summary: "Brand page header (products via GET /products?brand=)", params: idParam }, ({ params }) => svc.storeGet(params.id));

export const conciergeBrandsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge/brands", tag: "Concierge" })
  .get("/", { summary: "Brands we can source (/concierge-brands)", query: z.object({ q: z.string().max(80).optional() }) }, ({ query }) =>
    svc.storeList({ ...query, concierge: true }));

const body = z.object({
  name: z.string().trim().min(1).max(80), handle: z.string().max(80).optional(), tagline: z.string().max(190).nullable().optional(),
  description: z.string().max(5000).nullable().optional(), country: z.string().max(80).nullable().optional(),
  tier: z.enum(["signature", "core", "emerging"]).optional(), status: z.enum(["active", "draft", "archived"]).optional(),
  featured: z.boolean().optional(), conciergeOnly: z.boolean().optional(), logoUrl: z.string().max(1024).nullable().optional(),
  logoInitial: z.string().max(4).nullable().optional(), accent: z.string().max(16).nullable().optional(), website: z.string().max(190).nullable().optional(),
  seoTitle: z.string().max(190).nullable().optional(), seoDescription: z.string().max(500).nullable().optional(),
});
const audit = (action: string) => ({ category: "catalog", action, entity: "brand" });

/** asl-admin /brands */
export const brandsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/brands", tag: "Brands", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", {
    summary: "Brands table", permission: "catalog.view",
    query: z.object({ q: z.string().optional(), status: z.enum(["active", "draft", "archived"]).optional(), tier: z.enum(["signature", "core", "emerging"]).optional() }),
  }, ({ query }) => svc.adminList(query))
  .get("/:id", { summary: "Brand", permission: "catalog.view", params: idParam }, ({ params }) => svc.adminGet(params.id))
  .post("/", { summary: "Create brand", body, status: 201, audit: audit("brand.created") }, ({ body }) => svc.create(body))
  .patch("/:id", { summary: "Update brand (incl. status, tier, featured, concierge-only)", params: idParam, body: body.partial(), audit: audit("brand.updated") },
    async ({ params, body, res }) => {
      const r = await svc.update(params.id, body);
      res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated brand ${r.after.name}` };
      return r.after;
    })
  .post("/:id/duplicate", { summary: "Duplicate brand", params: idParam, status: 201, audit: audit("brand.duplicated") }, ({ params }) => svc.duplicate(params.id))
  .delete("/:id", { summary: "Delete brand (only without products)", params: idParam, audit: audit("brand.deleted") }, async ({ params }) => {
    await svc.remove(params.id);
    return { deleted: true };
  });
