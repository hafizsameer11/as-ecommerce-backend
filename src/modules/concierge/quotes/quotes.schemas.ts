import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const money = z.number().int().min(0).max(100_000_000_000);

export const quoteLine = z.object({
  name: z.string().trim().min(1).max(190),
  /** where it is bought (boutique, supplier, StockX …) */
  source: z.string().trim().max(120).optional(),
  qty: z.number().int().min(1).max(100).default(1),
  /** unit price, kobo */
  price: money.refine((n) => n > 0, "Enter a price"),
});

/** "Send quote". Fees and deposit default to the `concierge` settings; expiry = `concierge.quoteValidityHours`. */
export const createQuoteBody = z.object({
  lines: z.array(quoteLine).min(1).max(20),
  serviceFee: money.optional(),
  shippingEstimate: money.optional(),
  depositPct: z.number().int().min(1).max(100).optional(),
  note: z.string().trim().max(2000).optional(),
  /** hours; default `concierge.quoteValidityHours` */
  validityHours: z.number().int().min(1).max(24 * 30).optional(),
});
export const reviseQuoteBody = patchOf(createQuoteBody).extend({ lines: z.array(quoteLine).min(1).max(20).optional() });
export const withdrawBody = z.object({ reason: z.string().trim().max(500).optional() });

export const quoteTabs = ["all", "pending", "accepted", "paid", "expired", "declined"] as const;
export const adminQuotesQuery = pageQuery.extend({ tab: z.enum(quoteTabs).default("all"), requestId: z.string().max(64).optional() });

const address = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  address: z.string().trim().min(3).max(190),
  apartment: z.string().trim().max(190).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  postal: z.string().trim().max(20).optional(),
  country: z.string().trim().min(2).max(56).default("Nigeria"),
});

/** /concierge/payment: delivery address (saved one or typed) + how to pay */
export const acceptBody = z.object({
  addressId: z.string().max(64).optional(),
  address: address.optional(),
  method: z.enum(["card", "bank_transfer"]).default("card"),
  savedMethodId: z.string().max(64).optional(),
  saveCard: z.boolean().optional(),
  returnUrl: z.string().url().max(1024).optional(),
});
export const payBalanceBody = acceptBody.pick({ method: true, savedMethodId: true, returnUrl: true });
export const declineBody = z.object({
  reason: z.string().trim().min(2).max(500),
  /** true: close the request too; false (default): ask the team for another option */
  cancelRequest: z.boolean().default(false),
});

export type QuoteLineInput = z.infer<typeof quoteLine>;
export type CreateQuoteBody = z.infer<typeof createQuoteBody>;
export type ReviseQuoteBody = z.infer<typeof reviseQuoteBody>;
export type AdminQuotesQuery = z.infer<typeof adminQuotesQuery>;
export type AcceptBody = z.infer<typeof acceptBody>;
export type PayBalanceBody = z.infer<typeof payBalanceBody>;
export type DeclineBody = z.infer<typeof declineBody>;
