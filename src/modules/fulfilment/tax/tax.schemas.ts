import { z } from "zod";

const applies = z.array(z.enum(["products", "shipping", "concierge_fee"])).min(1);
export const taxRateBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["country", "state", "postcode"]),
  /** NG, NG-LA, 100001 */
  region: z.string().trim().min(1).max(20),
  /** percent, e.g. 7.5 */
  rate: z.number().min(0).max(100),
  basis: z.enum(["inclusive", "exclusive"]).default("inclusive"),
  appliesTo: applies,
  code: z.string().trim().min(1).max(40),
  active: z.boolean().default(true),
});
export const exemptionBody = z.object({
  entity: z.enum(["customer", "order"]),
  reference: z.string().trim().min(1).max(190),
  reason: z.string().trim().min(1).max(190),
  certificateRef: z.string().max(80).nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
});
export const taxCategoryBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullable().optional(),
  overrides: z.array(z.object({ region: z.string().max(20), rate: z.number().min(0).max(100) })).default([]),
});
export type TaxRateBody = z.infer<typeof taxRateBody>;
export type ExemptionBody = z.infer<typeof exemptionBody>;
export type TaxCategoryBody = z.infer<typeof taxCategoryBody>;
