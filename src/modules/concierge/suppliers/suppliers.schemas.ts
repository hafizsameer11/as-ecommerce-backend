import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const tier = z.enum(["diamond", "platinum", "gold", "silver"]);
const status = z.enum(["active", "paused", "blocked", "pending"]);
const list = z.array(z.string().trim().min(1).max(80)).max(50);

/** fields without defaults (PATCH must not reset anything it wasn't sent) */
const fields = z.object({
  name: z.string().trim().min(2).max(190),
  contact: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(190),
  phone: z.string().trim().min(3).max(40),
  country: z.string().trim().min(2).max(80),
  city: z.string().trim().min(1).max(80),
  categories: list,
  brands: list,
  tier,
  status,
  leadTimeDays: z.number().int().min(0).max(365),
  rating: z.number().min(0).max(5),
  paymentTerms: z.string().trim().max(60),
  currency: z.enum(["USD", "EUR", "GBP", "NGN"]),
  vip: z.boolean(),
  notes: z.string().trim().max(4000).nullable(),
  onTimeRate: z.number().min(0).max(100),
  fulfillmentRate: z.number().min(0).max(100),
});
export const supplierBody = fields.extend({
  categories: list.default([]),
  brands: list.default([]),
  tier: tier.default("silver"),
  status: status.default("pending"),
  leadTimeDays: z.number().int().min(0).max(365).default(7),
  rating: z.number().min(0).max(5).default(0),
  paymentTerms: z.string().trim().max(60).default("Prepaid"),
  currency: z.enum(["USD", "EUR", "GBP", "NGN"]).default("USD"),
  vip: z.boolean().default(false),
  notes: z.string().trim().max(4000).nullable().optional(),
  onTimeRate: z.number().min(0).max(100).optional(),
  fulfillmentRate: z.number().min(0).max(100).optional(),
});
export const supplierPatch = fields.partial();

export const suppliersQuery = pageQuery.extend({
  tab: z.enum(["all", "active", "pending", "paused", "blocked"]).default("all"),
  tier: tier.optional(),
  country: z.string().max(80).optional(),
  vip: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export type SupplierBody = z.infer<typeof supplierBody>;
export type SupplierPatch = z.infer<typeof supplierPatch>;
export type SuppliersQuery = z.infer<typeof suppliersQuery>;
