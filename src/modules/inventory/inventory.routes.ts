import { z } from "zod";
import { ModuleRouter, withMeta } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { inventoryService as svc } from "./inventory.service";

const audit = (action: string) => ({ category: "inventory", action, entity: "stock" });

/** asl-admin /inventory */
export const inventoryAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/inventory", tag: "Inventory", defaultAuth: "admin", defaultPermission: "inventory.adjust" })
  .get("/", {
    summary: "Stock by SKU × warehouse (+ summary: units, value, low, out)",
    permission: "catalog.view",
    query: z.object({
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50),
      q: z.string().optional(), warehouse: z.string().optional(), state: z.enum(["in", "low", "out"]).optional(),
    }),
  }, async ({ query }) => {
    const r = await svc.list(query);
    return withMeta(r.items, r.meta);
  })
  .post("/adjust", {
    summary: "Adjust / receive stock",
    body: z.object({ sku: z.string(), warehouseId: z.string(), delta: z.number().int().refine((n) => n !== 0, "Use a non-zero amount"), note: z.string().min(1).max(300), type: z.enum(["adjust", "receive"]).optional() }),
    audit: audit("stock.adjusted"),
  }, ({ body, admin, res }) => {
    res.locals.audit = { entityId: body.sku, summary: `${body.delta > 0 ? "+" : ""}${body.delta} ${body.sku} @ ${body.warehouseId}: ${body.note}` };
    return svc.adjust(body, admin.name);
  })
  .post("/transfer", {
    summary: "Transfer between warehouses",
    body: z.object({ sku: z.string(), from: z.string(), to: z.string(), qty: z.number().int().positive(), note: z.string().max(300).default("") }),
    audit: audit("stock.transferred"),
  }, ({ body, admin }) => svc.transfer(body, admin.name))
  .patch("/reorder-point", {
    summary: "Set reorder point",
    body: z.object({ sku: z.string(), warehouseId: z.string(), reorderPoint: z.number().int().min(0).max(100000) }),
    audit: audit("stock.reorder_point"),
  }, ({ body }) => svc.setReorderPoint(body.sku, body.warehouseId, body.reorderPoint))
  .get("/movements", {
    summary: "Stock movement history",
    permission: "catalog.view",
    query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50), sku: z.string().optional(), type: z.string().optional() }),
  }, async ({ query }) => {
    const r = await svc.movements(query);
    return withMeta(r.items, r.meta);
  });

export const warehousesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/warehouses", tag: "Inventory", defaultAuth: "admin", defaultPermission: "inventory.adjust" })
  .get("/", { summary: "Warehouses", permission: "catalog.view" }, () => prisma.warehouse.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] }))
  .post("/", {
    summary: "Add warehouse",
    body: z.object({ name: z.string().min(1).max(80), code: z.string().min(2).max(16).toUpperCase(), city: z.string().min(1).max(80) }),
    status: 201, audit: audit("warehouse.created"),
  }, ({ body }) => prisma.warehouse.create({ data: body }))
  .patch("/:id", {
    summary: "Update warehouse (name, city, active, default)",
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string().min(1).max(80).optional(), city: z.string().max(80).optional(), active: z.boolean().optional(), isDefault: z.boolean().optional() }),
    audit: audit("warehouse.updated"),
  }, async ({ params, body }) => {
    if (body.isDefault) await prisma.warehouse.updateMany({ data: { isDefault: false } });
    return prisma.warehouse.update({ where: { id: params.id }, data: body });
  });
