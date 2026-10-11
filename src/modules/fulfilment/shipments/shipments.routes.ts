import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { shipmentsController as c } from "./shipments.controller";
import { advanceBody, createShipmentBody, fulfilBody, shipmentListQuery, updateShipmentBody } from "./shipments.schemas";

const audit = (action: string, entity = "shipment") => ({ category: "orders", action, entity });

/** asl-admin /shipments */
export const shipmentsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/shipments", tag: "Shipments", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .get("/", { summary: "Shipments (tabs by status, search, carrier filter, KPIs)", permission: "orders.view", query: shipmentListQuery }, c.list)
  .post("/", { summary: "Create a shipment for a paid order", body: createShipmentBody, status: 201, audit: audit("shipment.created") }, c.create)
  .get("/:id", { summary: "Shipment + tracking events (id or SHP- number)", permission: "orders.view", params: idParam }, c.get)
  .patch("/:id", { summary: "Edit tracking, service, ETA, notes, insurance…", params: idParam, body: updateShipmentBody, audit: audit("shipment.updated") }, c.update)
  .post("/:id/advance", { summary: "Add a tracking scan / move status (drives the order status)", params: idParam, body: advanceBody, audit: audit("shipment.advanced") }, c.advance)
  .delete("/:id", { summary: "Delete (only while label created)", params: idParam, audit: audit("shipment.deleted") }, c.remove);

/** asl-admin order detail → "Fulfil" */
export const orderFulfilAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/orders", tag: "Orders", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .post("/:id/fulfil", { summary: "Create a shipment for a paid delivery order (pick-up orders use bookings)", params: idParam, body: fulfilBody, status: 201, audit: audit("order.fulfilled", "order") }, c.fulfil);

/** /account/track, order progress timeline */
export const myTrackingStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/orders", tag: "Orders", defaultAuth: "customer" })
  .get("/:id/tracking", { summary: "Tracking: status, shipments with events, pick-up booking", params: idParam }, c.myTracking);

/** guest confirmation page tracking */
export const tokenTrackingStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/orders", tag: "Orders" })
  .get("/by-token/:token/tracking", { summary: "Guest tracking by the order's private access token", params: z.object({ token: z.string().min(20).max(64) }) }, c.tokenTracking);
