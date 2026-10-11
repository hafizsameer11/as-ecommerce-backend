import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** reasons offered by the apps' "Start a return" form */
export const RETURN_REASONS = [
  "Wrong size", "Changed my mind", "Wrong colour received", "Damaged or defective",
  "Not as described", "Received wrong item", "Authenticity concern", "Other",
] as const;
export const DAMAGED_REASON = "Damaged or defective";

/** multipart sends `items` as a JSON string; JSON bodies send the array */
const jsonArray = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const returnLines = z.preprocess(
  jsonArray,
  z
    .array(z.object({ orderItemId: z.string().min(1).max(64), qty: z.coerce.number().int().min(1).max(100) }))
    .min(1, "Choose at least one item")
    .max(50)
    .refine((xs) => new Set(xs.map((x) => x.orderItemId)).size === xs.length, "Each item can only be listed once"),
);

export const createReturnBody = z.object({
  orderId: z.string().trim().min(1).max(64),
  items: returnLines,
  reason: z.enum(RETURN_REASONS),
  details: z.string().trim().max(2000).optional(),
  refundTo: z.enum(["original", "wallet"]).default("original"),
});

export const myReturnsQuery = pageQuery.extend({ status: z.enum(["In Progress", "Approved", "Completed", "Rejected"]).optional() });

export const returnTabs = ["all", "open", "awaiting_review", "approved", "in_transit", "received", "investigating", "refunded", "rejected"] as const;
export const adminReturnsQuery = pageQuery.extend({
  tab: z.enum(returnTabs).default("all"),
  customerId: z.string().max(64).optional(),
  orderId: z.string().max(64).optional(),
});

export const adminCreateBody = z.object({
  /** order id or number */
  orderId: z.string().trim().min(1).max(64),
  /** omit = everything still returnable on the order */
  items: returnLines.optional(),
  reason: z.string().trim().min(2).max(120),
  details: z.string().trim().max(2000).optional(),
  refundTo: z.enum(["original", "wallet"]).default("original"),
  /** kobo; default = suggested refund */
  refundAmount: z.number().int().min(0).optional(),
  /** skip the return window / non-returnable category rules (goodwill) */
  override: z.boolean().default(false),
});

export const noteBody = z.object({ note: z.string().trim().max(500).optional() });
export const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const investigateBody = z.object({ note: z.string().trim().min(3).max(500) });
export const receivedBody = z.object({ restock: z.boolean().default(true), note: z.string().trim().max(500).optional() });
export const refundBody = z.object({
  /** kobo; default = suggested refund (capped at what is still refundable on the order) */
  amount: z.number().int().positive().optional(),
  to: z.enum(["original", "wallet"]).default("original"),
  note: z.string().trim().max(500).optional(),
});

export type CreateReturnBody = z.infer<typeof createReturnBody>;
export type MyReturnsQuery = z.infer<typeof myReturnsQuery>;
export type AdminReturnsQuery = z.infer<typeof adminReturnsQuery>;
export type AdminCreateBody = z.infer<typeof adminCreateBody>;
export type ReceivedBody = z.infer<typeof receivedBody>;
export type ReturnRefundBody = z.infer<typeof refundBody>;
