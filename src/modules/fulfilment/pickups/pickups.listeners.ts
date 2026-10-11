import { events } from "@/core/events/bus";
import { pickupsService } from "./pickups.service";

let registered = false;

export function registerPickupListeners() {
  if (registered) return;
  registered = true;
  // pick-up orders get a slot as soon as they are paid
  events.on("order.paid", async ({ orderId }) => {
    await pickupsService.createBookingForOrder(orderId);
  });
  events.on("order.cancelled", ({ orderId }) => pickupsService.cancelBookingForOrder(orderId));
}
