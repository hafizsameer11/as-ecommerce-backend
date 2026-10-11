import { ModuleRouter, idParam } from "@/core/http/router";
import { collectionsController as c } from "./collections.controller";
import { collectionAdminQuery, collectionBody, collectionPatch, collectionSlotQuery } from "./collections.schemas";

export const collectionsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/collections", tag: "Collections" })
  .get("/", { summary: "Active collections for a slot (home rows, shop hub)", query: collectionSlotQuery }, c.bySlot)
  .get("/:id", { summary: "Collection page (/collection/:slug) with products", params: idParam }, c.storeGet);

const audit = (action: string) => ({ category: "catalog", action, entity: "collection" });

/** asl-admin /collections */
export const collectionsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/collections", tag: "Collections", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "Collections", permission: "catalog.view", query: collectionAdminQuery }, c.adminList)
  .get("/:id", { summary: "Collection", permission: "catalog.view", params: idParam }, c.adminGet)
  .get("/:id/preview", { summary: "Products this collection resolves to (smart rules)", permission: "catalog.view", params: idParam }, c.preview)
  .post("/", { summary: "Create collection", body: collectionBody, status: 201, audit: audit("collection.created") }, c.create)
  .patch("/:id", { summary: "Update collection (status, slot, featured, products, rules)", params: idParam, body: collectionPatch, audit: audit("collection.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate", params: idParam, status: 201, audit: audit("collection.duplicated") }, c.duplicate)
  .delete("/:id", { summary: "Delete", params: idParam, audit: audit("collection.deleted") }, c.remove);
