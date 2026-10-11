import { z } from "zod";

export const orderRef = z.object({ id: z.string().min(1).max(64) });
export const orderToken = z.object({ token: z.string().min(20).max(64) });
export const printSlipsBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
export const emailInvoiceBody = z.object({
  /** send somewhere else than the order's email (optional) */
  to: z.string().trim().email().optional(),
});

export type PrintSlipsBody = z.infer<typeof printSlipsBody>;
export type EmailInvoiceBody = z.infer<typeof emailInvoiceBody>;
