import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { SLUG_RE, normalizeSlug } from "../content.common";
import { patchOf } from "@/core/http/patch-schema";

export const BLOCK_TYPES = ["hero", "rich_text", "image", "gallery", "cta", "faq", "video", "columns", "quote"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const url = z.string().trim().max(1024).refine((u) => /^(https?:\/\/|\/)/.test(u), "Use an https:// link or a /path");
const href = z.string().trim().max(1024).refine((u) => /^(https?:\/\/|\/|#|mailto:|tel:)/.test(u), "Use a /path, https:// link, mailto: or tel:");
const text = (max = 300) => z.string().max(max);

/** one entry of a gallery / columns / faq block */
export const blockItem = z.object({
  title: text(300).optional(),
  body: text(20_000).optional(),
  imageUrl: url.optional(),
  alt: text(300).optional(),
  href: href.optional(),
  icon: text(60).optional(),
  value: text(120).optional(),
});

const common = {
  id: z.string().max(40).optional(),
  /** lucide icon name (the apps map it) */
  icon: text(60).optional(),
  /** layout hint for the apps: default · note · steps · cards · list · contact · stats … */
  variant: text(40).optional(),
  /** small label above the title ("OUR STORY") */
  eyebrow: text(120).optional(),
};

export const blockSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("hero"), title: text(300).min(1), body: text(5_000).optional(), imageUrl: url.optional(), alt: text(300).optional(), ctaLabel: text(80).optional(), ctaHref: href.optional() }),
  z.object({ ...common, type: z.literal("rich_text"), title: text(300).optional(), body: text(100_000).min(1) }),
  z.object({ ...common, type: z.literal("image"), imageUrl: url, alt: text(300).optional(), title: text(300).optional() }),
  z.object({ ...common, type: z.literal("gallery"), title: text(300).optional(), items: z.array(blockItem.extend({ imageUrl: url })).min(1).max(40) }),
  z.object({ ...common, type: z.literal("cta"), title: text(300).optional(), body: text(5_000).optional(), ctaLabel: text(80).min(1), ctaHref: href, items: z.array(blockItem).max(4).optional() }),
  z.object({
    ...common, type: z.literal("faq"), title: text(300).optional(),
    /** either inline Q&A (title = question, body = answer) or a FAQ category slug rendered live */
    items: z.array(blockItem.extend({ title: text(500).min(1), body: text(20_000).min(1) })).max(100).optional(),
    faqCategory: z.string().max(80).optional(),
  }).refine((b) => (b.items?.length ?? 0) > 0 || !!b.faqCategory, { message: "Add questions or pick a FAQ category", path: ["items"] }),
  z.object({ ...common, type: z.literal("video"), title: text(300).optional(), videoUrl: z.string().trim().url().max(1024).refine((u) => u.startsWith("https://"), "Use an https:// link"), imageUrl: url.optional() }),
  z.object({ ...common, type: z.literal("columns"), title: text(300).optional(), body: text(20_000).optional(), items: z.array(blockItem).min(1).max(24) }),
  z.object({ ...common, type: z.literal("quote"), body: text(5_000).min(1), title: text(300).optional() }),
]);
export type PageBlock = z.infer<typeof blockSchema> & { id: string };

/** PATCH a block: any field, re-validated as a whole after merging */
export const blockPatch = z.record(z.string(), z.unknown());
/** add a block: just a type (defaults are filled in) or a full block */
export const blockAdd = z.object({ type: z.enum(BLOCK_TYPES), position: z.number().int().min(0).optional() }).passthrough();
export const blockMove = z.union([z.object({ dir: z.union([z.literal(-1), z.literal(1)]) }), z.object({ to: z.number().int().min(0) })]);

const slug = z.string().max(190).transform(normalizeSlug).refine((s) => SLUG_RE.test(s), "Lowercase letters, numbers, - and / only");
const status = z.enum(["draft", "scheduled", "published", "archived"]);

const template = z.enum(["standard", "legal", "landing", "story", "help"]);
const visibility = z.enum(["public", "unlisted", "members"]);
const tags = z.array(z.string().trim().min(1).max(40)).max(30);

/** no defaults here: PATCH must not reset omitted fields */
const pageFields = z.object({
  title: z.string().trim().min(1).max(190),
  slug,
  template,
  visibility,
  subtitle: z.string().max(500).nullable(),
  author: z.string().max(120),
  seoTitle: z.string().max(190).nullable(),
  seoDescription: z.string().max(500).nullable(),
  ogImage: url.nullable(),
  heroImage: url.nullable(),
  showInHeader: z.boolean(),
  showInFooter: z.boolean(),
  tags,
  blocks: z.array(blockSchema).max(200),
});
export const pageCreate = patchOf(pageFields).extend({
  title: pageFields.shape.title,
  slug: slug.optional(),
  template: template.default("standard"),
  visibility: visibility.default("public"),
  showInHeader: z.boolean().default(false),
  showInFooter: z.boolean().default(false),
  tags: tags.default([]),
  status: z.enum(["draft", "published"]).default("draft"),
});
export const pagePatch = patchOf(pageFields);
export const pageStatusBody = z.object({ status, scheduledFor: z.coerce.date().nullable().optional() });

export const pageListQuery = pageQuery.extend({
  status: z.enum(["all", "draft", "scheduled", "published", "archived"]).default("all"),
  template: z.enum(["standard", "legal", "landing", "story", "help"]).optional(),
  visibility: z.enum(["public", "unlisted", "members"]).optional(),
});

/** store: /pages/customer-care/return-policy → "customer-care/return-policy" */
export const storeSlugParams = z.object({
  slug: z.union([z.string(), z.array(z.string())]).transform((s) => normalizeSlug(Array.isArray(s) ? s.join("/") : s)),
});
export const blockParams = z.object({ id: z.string().min(1).max(64), blockId: z.string().min(1).max(40) });

export type PageCreate = z.infer<typeof pageCreate>;
export type PagePatch = z.infer<typeof pagePatch>;
export type PageStatusBody = z.infer<typeof pageStatusBody>;
export type PageListQuery = z.infer<typeof pageListQuery>;
export type BlockAdd = z.infer<typeof blockAdd>;
export type BlockMove = z.infer<typeof blockMove>;
