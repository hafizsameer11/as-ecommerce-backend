import { events } from "@/core/events/bus";
import { shipmentsService } from "./shipments.service";

let registered = false;

export function registerShipmentListeners() {
  if (registered) return;
  registered = true;
  // cancelled before the parcel left the warehouse → unused labels go away
  events.on("order.cancelled", ({ orderId }) => shipmentsService.dropUnusedLabels(orderId));
}
