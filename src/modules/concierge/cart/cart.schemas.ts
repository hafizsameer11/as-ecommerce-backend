import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);

/** /concierge/cart line edits (qty stepper; size / colour / notes from the request detail) */
export const updateItemBody = z
  .object({
    qty: z.coerce.number().int().min(1).max(20).optional(),
    size: text(40).nullable().optional(),
    color: text(60).nullable().optional(),
    notes: text(4000).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change.");

export const removeItemBody = z.object({ reason: z.string().trim().max(500).optional() }).optional();

export type UpdateItemBody = z.infer<typeof updateItemBody>;