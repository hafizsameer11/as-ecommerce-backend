import { z } from "zod";
import { MAX_LINE_QTY } from "./carts.service";

export const addItemBody = z.object({
  /** product handle (e.g. "c1") or id */
  productId: z.string().min(1).max(64),
  size: z.string().max(40).nullable().optional(),
  color: z.string().max(60).nullable().optional(),
  qty: z.number().int().min(1).max(MAX_LINE_QTY).default(1),
});
export const updateItemBody = z
  .object({
    qty: z.number().int().min(1).max(MAX_LINE_QTY).optional(),
    size: z.string().max(40).nullable().optional(),
    color: z.string().max(60).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "Nothing to update");
export const mergeBody = z.object({ guestToken: z.string().min(20).max(64) });

export type AddItemBody = z.infer<typeof addItemBody>;
export type UpdateItemBody = z.infer<typeof updateItemBody>;
export type MergeBody = z.infer<typeof mergeBody>;
