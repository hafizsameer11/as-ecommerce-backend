import { z } from "zod";

export const labelsBody = z.object({
  /** shipment ids or SHP- numbers, printed in this order */
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});
export const carrierParam = z.object({ carrier: z.string().trim().min(2).max(40) });

/** carrier tracking update (stub format until a real carrier integration maps its own payload to this) */
export const carrierEventBody = z.object({
  trackingNumber: z.string().trim().min(3).max(120),
  /** our statuses (picked_up, in_transit, out_for_delivery, delivered, exception, returned) or common carrier words */
  status: z.string().trim().min(2).max(60),
  location: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
  occurredAt: z.coerce.date().optional(),
});

export type LabelsBody = z.infer<typeof labelsBody>;
export type CarrierEventBody = z.infer<typeof carrierEventBody>;
