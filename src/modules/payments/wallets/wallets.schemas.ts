import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const txQuery = pageQuery.extend({ type: z.enum(["credit", "debit"]).optional() });
export const topupBody = z.object({
  amount: z.number().int().positive(),
  method: z.enum(["card", "bank_transfer"]).default("card"),
  savedMethodId: z.string().max(64).nullable().optional(),
  /** where the payment page sends the customer back (your site or the app scheme) */
  returnUrl: z.string().url().max(500).nullable().optional(),
});
export const withdrawBody = z.object({ amount: z.number().int().positive(), bankAccountId: z.string().min(1).max(64) });
export const bankAccountBody = z.object({ bankCode: z.string().min(2).max(10), accountNumber: z.string().regex(/^\d{10}$/, "Enter a 10-digit account number") });

export const adminTxQuery = pageQuery.extend({
  kind: z.enum(["topup", "refund", "credit", "adjustment", "spend", "withdrawal", "expiry"]).optional(),
  status: z.enum(["pending", "completed", "failed", "reversed"]).optional(),
  customerId: z.string().max(64).optional(),
});
export const adjustBody = z.object({
  customerId: z.string().min(1).max(64),
  /** signed kobo (+ credit, − debit) */
  amount: z.number().int().refine((n) => n !== 0, "Amount can't be zero"),
  kind: z.enum(["credit", "adjustment"]).default("adjustment"),
  note: z.string().trim().min(3).max(300),
});
export const failBody = z.object({ reason: z.string().trim().min(3).max(300) });

export type TxQuery = z.infer<typeof txQuery>;
export type TopupBody = z.infer<typeof topupBody>;
export type WithdrawBody = z.infer<typeof withdrawBody>;
export type BankAccountBody = z.infer<typeof bankAccountBody>;
export type AdminTxQuery = z.infer<typeof adminTxQuery>;
export type AdjustBody = z.infer<typeof adjustBody>;
