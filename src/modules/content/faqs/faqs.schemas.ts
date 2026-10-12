import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const slug = z.string().trim().toLowerCase().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and - only");
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const categoryCreate = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  description: z.string().max(500).nullable().optional(),
  icon: z.string().max(60).optional(),
});
export const categoryPatch = patchOf(categoryCreate);
export const moveBody = z.object({ dir: z.union([z.literal(-1), z.literal(1)]) });

export const itemCreate = z.object({
  categoryId: z.string().min(1).max(64),
  question: z.string().trim().min(1).max(500),
  /** HTML allowed (sanitised); {{tokens}} are rendered from settings */
  answer: z.string().max(20_000).default(""),
  status: z.enum(["published", "draft"]).default("draft"),
  featured: z.boolean().default(false),
  tags: tags.default([]),
});
export const itemPatch = z.object({
  categoryId: z.string().min(1).max(64),
  question: z.string().trim().min(1).max(500),
  answer: z.string().max(20_000),
  status: z.enum(["published", "draft"]),
  featured: z.boolean(),
  tags,
}).partial();
export const itemStatusBody = z.object({ status: z.enum(["published", "draft", "archived"]) });

export const itemListQuery = pageQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
  categoryId: z.string().max(64).optional(),
  status: z.enum(["all", "published", "draft", "archived"]).default("all"),
  featured: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

/** store: ?category=<slug>&featured=true&q= */
export const storeFaqQuery = z.object({
  category: z.string().max(80).optional(),
  featured: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  q: z.string().trim().max(200).optional(),
});
export const feedbackBody = z.object({ helpful: z.boolean() });

export type CategoryCreate = z.infer<typeof categoryCreate>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type ItemCreate = z.infer<typeof itemCreate>;
export type ItemPatch = z.infer<typeof itemPatch>;
export type ItemListQuery = z.infer<typeof itemListQuery>;
export type StoreFaqQuery = z.infer<typeof storeFaqQuery>;
