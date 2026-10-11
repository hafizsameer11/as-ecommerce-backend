import { ModuleRouter } from "@/core/http/router";
import { inventoryController as c, warehousesController as w } from "./inventory.controller";
import * as s from "./inventory.schemas";

const audit = (action: string) => ({ category: "inventory", action, entity: "stock" });

/** asl-admin /inventory */
export const inventoryAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/inventory", tag: "Inventory", defaultAuth: "admin", defaultPermission: "inventory.adjust" })
  .get("/", { summary: "Stock by SKU × warehouse (+ summary: units, value, low, out)", permission: "catalog.view", query: s.stockListQuery }, c.list)
  .post("/adjust", { summary: "Adjust / receive stock", body: s.adjustBody, audit: audit("stock.adjusted") }, c.adjust)
  .post("/transfer", { summary: "Transfer between warehouses", body: s.transferBody, audit: audit("stock.transferred") }, c.transfer)
  .patch("/reorder-point", { summary: "Set reorder point", body: s.reorderPointBody, audit: audit("stock.reorder_point") }, c.setReorderPoint)
  .get("/movements", { summary: "Stock movement history", permission: "catalog.view", query: s.movementsQuery }, c.movements);

export const warehousesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/warehouses", tag: "Inventory", defaultAuth: "admin", defaultPermission: "inventory.adjust" })
  .get("/", { summary: "Warehouses", permission: "catalog.view" }, w.list)
  .post("/", { summary: "Add warehouse", body: s.warehouseBody, status: 201, audit: audit("warehouse.created") }, w.create)
  .patch("/:id", { summary: "Update warehouse (name, city, active, default)", params: s.warehouseIdParam, body: s.warehousePatch, audit: audit("warehouse.updated") }, w.update);
