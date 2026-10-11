import { ModuleRouter, idParam } from "@/core/http/router";
import { pickupsController as c } from "./pickups.controller";
import { locationBody } from "./pickups.schemas";

export const pickupLocationsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/pickup-locations", tag: "Shipping" })
  .get("/", { summary: "Stores offering pick-up (checkout, store locator)" }, c.storeLocations);

const audit = (action: string) => ({ category: "settings", action, entity: "pickup_location" });

/** asl-admin /pickups → locations. Pick-up bookings are added with fulfilment (phase 4). */
export const pickupLocationsAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/pickup-locations", tag: "Pick-ups", defaultAuth: "admin", defaultPermission: "settings.manage",
})
  .get("/", { summary: "Pick-up locations", permission: "orders.view" }, c.listLocations)
  .post("/", { summary: "Add location", body: locationBody, status: 201, audit: audit("pickup_location.created") }, c.createLocation)
  .patch("/:id", { summary: "Update location", params: idParam, body: locationBody.partial(), audit: audit("pickup_location.updated") }, c.updateLocation)
  .delete("/:id", { summary: "Delete location (deactivates if orders used it)", params: idParam, audit: audit("pickup_location.deleted") }, c.removeLocation);
