import { z } from "zod";
import { patchOf } from "@/core/http/patch-schema";

const list = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v), z.array(t)).optional();
const bool = z.preprocess((v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v), z.boolean()).optional();

export const SORTS = ["featured", "newest", "price_asc", "price_desc", "best_selling", "trending", "rating", "name"] as const;

export const storeListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().max(60).optional(),
  subcategory: z.string().max(80).optional(),
  brand: list(z.string()),
  size: list(z.string()),
  color: list(z.string()),
  availability: list(z.enum(["in_stock", "pre_order", "limited", "restocked"])),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  onSale: bool,
  concierge: bool,
  inStock: bool,
  collection: z.string().max(80).optional(),
  ids: list(z.string()),
  sort: z.enum(SORTS).default("featured"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
export type StoreListQuery = z.infer<typeof storeListQuery>;

const color = z.object({ name: z.string().min(1).max(40), hex: z.string().regex(/^#[0-9a-fA-F]{3,8}$/) });
const image = z.object({ url: z.string().min(1).max(1024), alt: z.string().max(200).optional(), color: z.string().max(40).optional() });

export const productInput = z.object({
  name: z.string().trim().min(1).max(190),
  handle: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/).max(100).optional(),
  brandId: z.string(),
  categoryId: z.string(),
  subcategoryId: z.string().nullable().optional(),
  price: z.number().int().min(0),
  compareAtPrice: z.number().int().min(0).nullable().optional(),
  cost: z.number().int().min(0).nullable().optional(),
  description: z.string().max(10_000).nullable().optional(),
  features: z.array(z.string().max(500)).max(20).optional(),
  styleCode: z.string().max(60).nullable().optional(),
  availability: z.enum(["in_stock", "pre_order", "limited", "restocked"]).default("in_stock"),
  status: z.enum(["active", "draft", "archived"]).default("draft"),
  isConcierge: z.boolean().default(false),
  priceOnRequest: z.boolean().default(false),
  featured: z.boolean().default(false),
  modelFit: z.string().max(500).nullable().optional(),
  useDesignerSizes: z.boolean().optional(),
  sizes: z.array(z.string().min(1).max(20)).max(40).optional(),
  colors: z.array(color).max(20).optional(),
  images: z.array(image).max(30).optional(),
  sizeLabels: z.record(z.string(), z.string().max(40)).optional(),
  seoTitle: z.string().max(190).nullable().optional(),
  seoDescription: z.string().max(500).nullable().optional(),
});
export const productPatch = patchOf(productInput);

export const adminListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(120).optional(),
  status: z.enum(["active", "draft", "archived"]).optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  stock: z.enum(["in", "low", "out", "preorder"]).optional(),
  sort: z.string().max(20).optional(),
});

export const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(["publish", "draft", "archive", "delete", "setCategory", "feature", "unfeature"]),
  categoryId: z.string().optional(),
  subcategoryId: z.string().nullable().optional(),
});

export const alsoLikeQuery = z.object({ exclude: z.string().optional(), limit: z.coerce.number().int().min(1).max(24).default(8) });
export const relatedQuery = z.object({ limit: z.coerce.number().int().min(1).max(12).default(4) });
export const productStatusBody = z.object({ status: z.enum(["active", "draft", "archived"]) });

export type AlsoLikeQuery = z.infer<typeof alsoLikeQuery>;
export type RelatedQuery = z.infer<typeof relatedQuery>;
export type ProductInput = z.infer<typeof productInput>;
export type ProductPatch = z.infer<typeof productPatch>;
export type AdminListQuery = z.infer<typeof adminListQuery>;
export type BulkBody = z.infer<typeof bulkSchema>;
export type ProductStatusBody = z.infer<typeof productStatusBody>;
