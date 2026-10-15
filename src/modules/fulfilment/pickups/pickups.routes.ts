import { ModuleRouter, idParam } from "@/core/http/router";
import { pickupsController as c } from "./pickups.controller";
import { bookingAdvanceBody, bookingListQuery, bookingNoteBody, bookingRescheduleBody, locationBody } from "./pickups.schemas";
import { patchOf } from "@/core/http/patch-schema";

export const pickupLocationsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/pickup-locations", tag: "Shipping" })
  .get("/", { summary: "Stores offering pick-up (checkout, store locator)" }, c.storeLocations);

const locAudit = (action: string) => ({ category: "settings", action, entity: "pickup_location" });
const locOpts = { surface: "admin" as const, tag: "Pick-ups", defaultAuth: "admin" as const, defaultPermission: "settings.manage" as const };

function locationsAdmin(prefix: string) {
  return new ModuleRouter({ ...locOpts, prefix })
    .get("/", { summary: "Pick-up locations", permission: "orders.view" }, c.listLocations)
    .post("/", { summary: "Add location", body: locationBody, status: 201, audit: locAudit("pickup_location.created") }, c.createLocation)
    .patch("/:id", { summary: "Update location", params: idParam, body: patchOf(locationBody), audit: locAudit("pickup_location.updated") }, c.updateLocation)
    .delete("/:id", { summary: "Delete location (deactivates if orders used it)", params: idParam, audit: locAudit("pickup_location.deleted") }, c.removeLocation);
}

/** asl-admin /pickups → locations tab */
export const pickupLocationsAdminRoutes = locationsAdmin("/pickups/locations");
/** older path kept so existing clients keep working */
export const pickupLocationsAdminLegacyRoutes = locationsAdmin("/pickup-locations");

const bookingAudit = (action: string) => ({ category: "orders", action, entity: "pickup_booking" });

/** asl-admin /pickups → bookings (dashboard "Today's pickups", "Ready to collect") */
export const pickupBookingsAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/pickups/bookings", tag: "Pick-ups", defaultAuth: "admin", defaultPermission: "orders.edit",
})
  .get("/", { summary: "Pick-up bookings (tabs + counts, location / day filter)", permission: "orders.view", query: bookingListQuery }, c.listBookings)
  .get("/:id", { summary: "Booking (id or PU- number)", permission: "orders.view", params: idParam }, c.getBooking)
  .post("/:id/advance", {
    summary: "Ready (notifies the customer) · Collected (order delivered) · No-show · Cancelled",
    description: "Body: `{ status }` or `{ action, note? }` where action is ready|collected|no_show|cancelled.",
    params: idParam, body: bookingAdvanceBody, audit: bookingAudit("pickup.advanced"),
  }, c.advanceBooking)
  .post("/:id/notes", { summary: "Set the booking note", params: idParam, body: bookingNoteBody, audit: bookingAudit("pickup.note") }, c.bookingNote)
  .patch("/:id", { summary: "Reschedule (day / store), within the store's daily capacity", params: idParam, body: bookingRescheduleBody, audit: bookingAudit("pickup.rescheduled") }, c.reschedule);
