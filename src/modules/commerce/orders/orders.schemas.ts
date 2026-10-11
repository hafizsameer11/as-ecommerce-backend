import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const myOrdersQuery = pageQuery.extend({ status: z.enum(["Processing", "Shipped", "Delivered", "Cancelled", "Returned"]).optional() });
export const orderRef = z.object({ id: z.string().min(1).max(64) });
export const cancelBody = z.object({ reason: z.string().trim().max(300).optional() });
export const payAgainBody = z.object({
  method: z.enum(["card", "bank_transfer"]).default("card"),
  savedMethodId: z.string().max(64).nullable().optional(),
  returnUrl: z.string().url().max(500).nullable().optional(),
});
export const lookupBody = z.object({ orderNumber: z.string().trim().min(3).max(40), email: z.string().trim().email() });

const status = z.enum(["pending_payment", "paid", "processing", "shipped", "out_for_delivery", "delivered", "cancelled", "returned", "refunded", "partially_refunded"]);
export const adminOrderQuery = pageQuery.extend({
  tab: z.enum(["all", "open", "unfulfilled", "awaiting_payment", "processing", "shipped", "delivered", "cancelled", "returns"]).default("all"),
  channel: z.enum(["web", "mobile", "pwa", "concierge", "draft"]).optional(),
  paymentStatus: z.enum(["unpaid", "partially_paid", "paid", "refunded", "partially_refunded", "failed"]).optional(),
  customerId: z.string().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const statusBody = z.object({ status, note: z.string().max(300).optional() });
export const bulkBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200), status });
export const adminCancelBody = z.object({ reason: z.string().trim().min(3).max(300), refundTo: z.enum(["original", "wallet"]).default("original") });
export const markPaidBody = z.object({ reference: z.string().trim().min(3).max(120), method: z.enum(["bank_transfer", "cash", "pos", "other"]).default("bank_transfer"), note: z.string().max(300).optional() });
export const noteBody = z.object({ body: z.string().trim().min(1).max(5000) });
export const refundBody = z.object({
  /** kobo; omit for everything still refundable */
  amount: z.number().int().positive().optional(),
  reason: z.string().trim().min(3).max(300),
  to: z.enum(["original", "wallet"]).default("original"),
  /** put the items back on sale (only before shipping) */
  restock: z.boolean().default(false),
});

export type AdminOrderQuery = z.infer<typeof adminOrderQuery>;
export type RefundBody = z.infer<typeof refundBody>;
