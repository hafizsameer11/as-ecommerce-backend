import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { shippingZonesController as c } from "./shipping-zones.controller";
import { quoteQuery, rateBody, zoneBody } from "./shipping-zones.schemas";
import { patchOf } from "@/core/http/patch-schema";

/** checkout delivery-fee card, cart estimate, shipping-policy page */
export const shippingStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/shipping", tag: "Shipping" })
  .get("/quote", { summary: "Delivery options + fees for a destination", query: quoteQuery }, c.quote)
  .get("/rates", { summary: "Delivery-fee table for the shipping-policy page" }, c.table);

const audit = (action: string) => ({ category: "settings", action, entity: "shipping_zone" });
const rateParams = idParam.extend({ rateId: z.string().min(1).max(64) });

/** asl-admin /shipping-zones */
export const shippingZonesAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/shipping-zones", tag: "Shipping zones", defaultAuth: "admin", defaultPermission: "settings.manage",
})
  .get("/", { summary: "Zones with rates and 30-day stats", permission: "orders.view" }, c.list)
  .get("/:id", { summary: "Zone", permission: "orders.view", params: idParam }, c.get)
  .post("/", { summary: "Create zone", body: zoneBody, status: 201, audit: audit("shipping_zone.created") }, c.create)
  .patch("/:id", { summary: "Update zone (sending `rates` replaces all rates)", params: idParam, body: patchOf(zoneBody), audit: audit("shipping_zone.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate zone (created inactive)", params: idParam, status: 201, audit: audit("shipping_zone.duplicated") }, c.duplicate)
  .post("/:id/toggle", { summary: "Activate / deactivate", params: idParam, audit: audit("shipping_zone.toggled") }, c.toggle)
  .delete("/:id", { summary: "Delete zone", params: idParam, audit: audit("shipping_zone.deleted") }, c.remove)
  .post("/:id/rates", { summary: "Add rate", params: idParam, body: rateBody, status: 201, audit: audit("shipping_rate.created") }, c.addRate)
  .put("/:id/rates/:rateId", { summary: "Update rate", params: rateParams, body: rateBody, audit: audit("shipping_rate.updated") }, c.updateRate)
  .delete("/:id/rates/:rateId", { summary: "Delete rate", params: rateParams, audit: audit("shipping_rate.deleted") }, c.removeRate);
