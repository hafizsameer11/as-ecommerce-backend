import { ModuleRouter, idParam } from "@/core/http/router";
import { pickupsController as c } from "./pickups.controller";
import { bookingAdvanceBody, bookingListQuery, bookingNoteBody, bookingRescheduleBody, locationBody } from "./pickups.schemas";

export const pickupLocationsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/pickup-locations", tag: "Shipping" })
  .get("/", { summary: "Stores offering pick-up (checkout, store locator)" }, c.storeLocations);

const audit = (action: string) => ({ category: "settings", action, entity: "pickup_location" });

/** asl-admin /pickups → locations */
export const pickupLocationsAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/pickup-locations", tag: "Pick-ups", defaultAuth: "admin", defaultPermission: "settings.manage",
})
  .get("/", { summary: "Pick-up locations", permission: "orders.view" }, c.listLocations)
  .post("/", { summary: "Add location", body: locationBody, status: 201, audit: audit("pickup_location.created") }, c.createLocation)
  .patch("/:id", { summary: "Update location", params: idParam, body: locationBody.partial(), audit: audit("pickup_location.updated") }, c.updateLocation)
  .delete("/:id", { summary: "Delete location (deactivates if orders used it)", params: idParam, audit: audit("pickup_location.deleted") }, c.removeLocation);

const bookingAudit = (action: string) => ({ category: "orders", action, entity: "pickup_booking" });

/** asl-admin /pickups → bookings (dashboard "Today's pickups", "Ready to collect") */
export const pickupBookingsAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/pickups/bookings", tag: "Pick-ups", defaultAuth: "admin", defaultPermission: "orders.edit",
})
  .get("/", { summary: "Pick-up bookings (tabs + counts, location / day filter)", permission: "orders.view", query: bookingListQuery }, c.listBookings)
  .get("/:id", { summary: "Booking (id or PU- number)", permission: "orders.view", params: idParam }, c.getBooking)
  .post("/:id/advance", { summary: "Ready (notifies the customer) · Collected (order delivered) · No-show · Cancelled", params: idParam, body: bookingAdvanceBody, audit: bookingAudit("pickup.advanced") }, c.advanceBooking)
  .post("/:id/notes", { summary: "Set the booking note", params: idParam, body: bookingNoteBody, audit: bookingAudit("pickup.note") }, c.bookingNote)
  .patch("/:id", { summary: "Reschedule (day / store), within the store's daily capacity", params: idParam, body: bookingRescheduleBody, audit: bookingAudit("pickup.rescheduled") }, c.reschedule);
