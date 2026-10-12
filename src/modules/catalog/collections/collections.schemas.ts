import { z } from "zod";
import { patchOf } from "@/core/http/patch-schema";

export const collectionSlotQuery = z.object({ slot: z.enum(["hero", "home_row_1", "home_row_2", "shop_hub"]) });
export const collectionAdminQuery = z.object({ q: z.string().optional(), status: z.enum(["active", "scheduled", "draft", "archived"]).optional() });

export const collectionRule = z.object({
  field: z.enum(["category", "brand", "price", "availability", "subcategory"]),
  op: z.enum(["is", "is_not", "gt", "lt", "contains"]),
  value: z.string().max(120),
});
export const collectionBody = z.object({
  title: z.string().trim().min(1).max(120), handle: z.string().max(100).optional(), description: z.string().max(5000).nullable().optional(),
  status: z.enum(["active", "scheduled", "draft", "archived"]).optional(), type: z.enum(["manual", "smart"]).optional(),
  slot: z.enum(["hero", "home_row_1", "home_row_2", "shop_hub", "none"]).optional(), rules: z.array(collectionRule).max(20).optional(),
  productIds: z.array(z.string()).max(500).optional(), coverUrl: z.string().max(1024).nullable().optional(), featured: z.boolean().optional(),
  sortOrder: z.enum(["manual", "newest", "price_asc", "price_desc", "bestseller"]).optional(), tags: z.array(z.string().max(40)).max(20).optional(),
  scheduledFor: z.string().datetime().nullable().optional(),
});
export const collectionPatch = patchOf(collectionBody);

export type CollectionSlotQuery = z.infer<typeof collectionSlotQuery>;
export type CollectionAdminQuery = z.infer<typeof collectionAdminQuery>;
export type CollectionBody = z.infer<typeof collectionBody>;
export type CollectionPatch = z.infer<typeof collectionPatch>;
