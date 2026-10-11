import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const CARRIERS = ["DHL", "FedEx", "UPS", "GIG", "Aramex", "Local", "InHouse"] as const;
export const SHIPMENT_STATUSES = ["label_created", "picked_up", "in_transit", "out_for_delivery", "delivered", "exception", "returned"] as const;

/** the admin UI says "In-house" */
const carrier = z.preprocess((v) => (typeof v === "string" && /^in[-\s]?house$/i.test(v) ? "InHouse" : v), z.enum(CARRIERS));

const shipmentFields = {
  carrier,
  service: z.string().trim().min(1).max(80),
  trackingNumber: z.string().trim().max(120).nullable().optional(),
  weightKg: z.number().min(0).max(1000).optional(),
  /** what the carrier charges us, kobo */
  cost: z.number().int().min(0).optional(),
  insured: z.boolean().optional(),
  signatureRequired: z.boolean().optional(),
  etaAt: z.coerce.date().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  originWarehouseId: z.string().max(64).nullable().optional(),
};

/** POST /admin/orders/:id/fulfil */
export const fulfilBody = z.object(shipmentFields);
/** POST /admin/shipments (same as fulfil, order in the body) */
export const createShipmentBody = fulfilBody.extend({ orderId: z.string().min(1).max(64) });
export const updateShipmentBody = z.object(shipmentFields).partial();
export const advanceBody = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  location: z.string().trim().min(1).max(120),
  note: z.string().trim().max(300).optional(),
});
export const shipmentListQuery = pageQuery.extend({
  tab: z.enum(["all", ...SHIPMENT_STATUSES]).default("all"),
  carrier: carrier.optional(),
  orderId: z.string().max(64).optional(),
});

export type FulfilBody = z.infer<typeof fulfilBody>;
export type CreateShipmentBody = z.infer<typeof createShipmentBody>;
export type UpdateShipmentBody = z.infer<typeof updateShipmentBody>;
export type AdvanceBody = z.infer<typeof advanceBody>;
export type ShipmentListQuery = z.infer<typeof shipmentListQuery>;
