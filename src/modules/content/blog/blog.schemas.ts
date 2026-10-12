import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const slug = z.string().trim().toLowerCase().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and - only");
const url = z.string().trim().max(1024).refine((u) => /^(https?:\/\/|\/)/.test(u), "Use an https:// link or a /path");
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

const postFields = z.object({
  title: z.string().trim().min(1).max(190),
  slug,
  excerpt: z.string().max(1000),
  /** markdown or HTML (HTML is sanitised) */
  content: z.string().max(500_000),
  coverUrl: url.nullable(),
  categoryId: z.string().min(1).max(64),
  authorId: z.string().min(1).max(64),
  tags,
  featured: z.boolean(),
  /** auto-calculated from the content when omitted */
  readingMinutes: z.number().int().min(1).max(120),
  seoTitle: z.string().max(190).nullable(),
  seoDescription: z.string().max(500).nullable(),
  ogImage: url.nullable(),
});
export const postCreate = patchOf(postFields).extend({
  title: postFields.shape.title,
  categoryId: postFields.shape.categoryId,
  authorId: postFields.shape.authorId,
  excerpt: z.string().max(1000).default(""),
  content: z.string().max(500_000).default(""),
  tags: tags.default([]),
  featured: z.boolean().default(false),
  status: z.enum(["draft", "published"]).default("draft"),
});
export const postPatch = patchOf(postFields);
export const postStatusBody = z.object({ status: z.enum(["draft", "scheduled", "published", "archived"]), scheduledFor: z.coerce.date().nullable().optional() });

export const postListQuery = pageQuery.extend({
  status: z.enum(["all", "draft", "scheduled", "published", "archived"]).default("all"),
  categoryId: z.string().max(64).optional(),
  authorId: z.string().max(64).optional(),
  featured: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export const categoryCreate = z.object({
  name: z.string().trim().min(1).max(80),
  slug: slug.optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #rrggbb colour").optional(),
});
export const categoryPatch = patchOf(categoryCreate);

export const authorCreate = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).default("Contributor"),
  avatarUrl: url.nullable().optional(),
});
export const authorPatch = z.object({ name: z.string().trim().min(1).max(120), role: z.string().trim().max(120), avatarUrl: url.nullable() }).partial();

/** store: /blog?category=style&featured=true&tag=&q= */
export const storeBlogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  category: z.string().max(80).optional(),
  featured: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  tag: z.string().max(40).optional(),
  q: z.string().trim().max(200).optional(),
});
export const slugParam = z.object({ slug: z.string().min(1).max(190) });

export type PostCreate = z.infer<typeof postCreate>;
export type PostPatch = z.infer<typeof postPatch>;
export type PostStatusBody = z.infer<typeof postStatusBody>;
export type PostListQuery = z.infer<typeof postListQuery>;
export type CategoryCreate = z.infer<typeof categoryCreate>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type AuthorCreate = z.infer<typeof authorCreate>;
export type AuthorPatch = z.infer<typeof authorPatch>;
export type StoreBlogQuery = z.infer<typeof storeBlogQuery>;
