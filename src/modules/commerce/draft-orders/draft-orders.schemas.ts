import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const money = z.number().int().min(0); // kobo

export const draftItemInput = z
  .object({
    /** catalogue product (id or handle); omit for a custom line */
    productId: z.string().trim().min(1).max(191).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    brand: z.string().trim().max(120).optional(),
    size: z.string().trim().max(40).nullable().optional(),
    color: z.string().trim().max(60).nullable().optional(),
    qty: z.number().int().min(1).max(100),
    /** kobo; overrides the catalogue price (required for custom lines) */
    unitPrice: money.optional(),
    imageUrl: z.string().max(1024).nullable().optional(),
  })
  .refine((i) => i.productId || (i.name && i.unitPrice !== undefined), { message: "A custom line needs a name and a unit price." });

export const createDraftBody = z
  .object({
    customerId: z.string().min(1).max(64).optional(),
    customerName: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    items: z.array(draftItemInput).min(1).max(100),
    discount: money.default(0),
    shipping: money.default(0),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.customerId || b.customerName, { message: "Choose a customer or enter a name.", path: ["customerName"] });

export const updateDraftBody = z.object({
  customerId: z.string().min(1).max(64).nullable().optional(),
  customerName: z.string().trim().min(1).max(160).optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  items: z.array(draftItemInput).min(1).max(100).optional(),
  discount: money.optional(),
  shipping: money.optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export const draftListQuery = pageQuery.extend({
  tab: z.enum(["all", "draft", "sent", "converted"]).default("all"),
});

export const sendDraftBody = z.object({
  /** override / set the email the pay link goes to */
  email: z.string().trim().toLowerCase().email().optional(),
});

export const convertDraftBody = z.object({
  reference: z.string().trim().min(3).max(120),
  method: z.enum(["bank_transfer", "cash", "pos", "other"]).default("bank_transfer"),
  note: z.string().max(300).optional(),
});

export const payTokenParam = z.object({ token: z.string().min(20).max(64) });
export const payDraftBody = z.object({
  method: z.enum(["card", "bank_transfer"]).default("card"),
  returnUrl: z.string().url().max(500).nullable().optional(),
});

export type DraftItemInput = z.infer<typeof draftItemInput>;
export type CreateDraftBody = z.infer<typeof createDraftBody>;
export type UpdateDraftBody = z.infer<typeof updateDraftBody>;
export type DraftListQuery = z.infer<typeof draftListQuery>;
export type SendDraftBody = z.infer<typeof sendDraftBody>;
export type ConvertDraftBody = z.infer<typeof convertDraftBody>;
export type PayDraftBody = z.infer<typeof payDraftBody>;
