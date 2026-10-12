import { z } from "zod";
import { acceptBody } from "../quotes/quotes.schemas";

const text = (max: number) => z.string().trim().max(max);

/** /concierge/cart line edits (qty stepper; size / colour / notes from the request detail) */
export const updateItemBody = z
  .object({
    qty: z.number().int().min(1).max(20).optional(),
    size: text(40).nullable().optional(),
    color: text(60).nullable().optional(),
    notes: text(4000).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change.");

export const removeItemBody = z.object({ reason: z.string().trim().max(500).optional() }).default({});

/**
 * /concierge/payment "Continue to Payment": accept + pay several quoted items in one payment.
 * `requestIds` (ids or ASL numbers) default to every cart item that can be paid now.
 * Delivery address as for a single quote: `addressId`, `address` or the saved default.
 */
export const checkoutBody = acceptBody.extend({
  requestIds: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
  /** contact phone for the delivery (stored on the requests) */
  phone: z.string().trim().min(7).max(30).optional(),
});
export const checkoutPreviewQuery = z.object({
  /** comma-separated ids / ASL numbers; default every payable cart item */
  ids: z.string().max(2000).optional(),
});

export type UpdateItemBody = z.infer<typeof updateItemBody>;
export type CheckoutBody = z.infer<typeof checkoutBody>;
