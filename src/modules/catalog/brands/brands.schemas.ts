import { z } from "zod";

export const brandStoreQuery = z.object({ q: z.string().max(80).optional(), featured: z.coerce.boolean().optional() });
export const conciergeBrandQuery = z.object({ q: z.string().max(80).optional() });
export const brandAdminQuery = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "draft", "archived"]).optional(),
  tier: z.enum(["signature", "core", "emerging"]).optional(),
});

export const brandBody = z.object({
  name: z.string().trim().min(1).max(80), handle: z.string().max(80).optional(), tagline: z.string().max(190).nullable().optional(),
  description: z.string().max(5000).nullable().optional(), country: z.string().max(80).nullable().optional(),
  tier: z.enum(["signature", "core", "emerging"]).optional(), status: z.enum(["active", "draft", "archived"]).optional(),
  featured: z.boolean().optional(), conciergeOnly: z.boolean().optional(), logoUrl: z.string().max(1024).nullable().optional(),
  logoInitial: z.string().max(4).nullable().optional(), accent: z.string().max(16).nullable().optional(), website: z.string().max(190).nullable().optional(),
  seoTitle: z.string().max(190).nullable().optional(), seoDescription: z.string().max(500).nullable().optional(),
});
export const brandPatch = brandBody.partial();

export type BrandStoreQuery = z.infer<typeof brandStoreQuery>;
export type ConciergeBrandQuery = z.infer<typeof conciergeBrandQuery>;
export type BrandAdminQuery = z.infer<typeof brandAdminQuery>;
export type BrandBody = z.infer<typeof brandBody>;
export type BrandPatch = z.infer<typeof brandPatch>;
