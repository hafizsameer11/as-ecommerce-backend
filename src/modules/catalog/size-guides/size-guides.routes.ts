import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";

export const sizeGuidesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/size-guides", tag: "Size guides" })
  .get("/", {
    summary: "Size guide notes for a product (brand guide wins over category guide)",
    query: z.object({ brand: z.string().optional(), category: z.string().optional() }),
  }, async ({ query }) => {
    const rows = await prisma.sizeGuide.findMany({
      where: { OR: [query.brand ? { scope: "brand", target: query.brand } : {}, query.category ? { scope: "category", target: query.category } : {}].filter((o) => Object.keys(o).length) as any },
    });
    return rows.sort((a) => (a.scope === "brand" ? -1 : 1));
  });

const body = z.object({ scope: z.enum(["brand", "category"]), target: z.string().min(1).max(80), note: z.string().min(1).max(2000), chartUrl: z.string().max(1024).nullable().optional() });

/** asl-admin /size-guides */
export const sizeGuidesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/size-guides", tag: "Size guides", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "All size guides", permission: "catalog.view" }, () => prisma.sizeGuide.findMany({ orderBy: [{ scope: "asc" }, { target: "asc" }] }))
  .put("/", { summary: "Create or replace the guide for a brand/category", body, audit: { category: "catalog", action: "size_guide.saved", entity: "size_guide" } }, ({ body }) =>
    prisma.sizeGuide.upsert({ where: { scope_target: { scope: body.scope, target: body.target } }, create: body, update: body }))
  .delete("/:id", { summary: "Delete a size guide", params: idParam, audit: { category: "catalog", action: "size_guide.deleted", entity: "size_guide" } }, async ({ params }) => {
    await prisma.sizeGuide.delete({ where: { id: params.id } });
    return { deleted: true };
  });
