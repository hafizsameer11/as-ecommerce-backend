import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

/** "/Shop/Footwear/?x=1" → "/Shop/Footwear" */
export const normalizePath = (p: string) => {
  let s = p.trim().split(/[?#]/)[0];
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      /* keep */
    }
  }
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\/{2,}/g, "/");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};
const path = z.string().trim().min(1).max(500).transform(normalizePath).refine((p) => /^\/[\w\-./~%]*$/.test(p), "Use a path like /shop/footwear");
const absOrPath = z.string().trim().min(1).max(1024).refine((u) => u.startsWith("/") || /^https?:\/\//.test(u), "Use a /path or an https:// link");
const optUrl = z.string().trim().max(1024).refine((u) => u === "" || u.startsWith("/") || /^https?:\/\//.test(u), "Use a /path or an https:// link");

export const seoConfigSchema = z.object({
  /** "%s · ASL ORIGINALS" */
  defaultTitleTemplate: z.string().max(120).refine((s) => s.includes("%s"), "Must contain %s"),
  defaultDescription: z.string().max(500),
  siteName: z.string().min(1).max(120),
  siteUrl: z.string().url().max(300),
  robotsTxt: z.string().max(20_000),
  ogImageDefault: optUrl,
  twitterHandle: z.string().max(60),
  gaMeasurementId: z.string().max(40),
  gscVerification: z.string().max(200),
  autoGenerateSitemap: z.boolean(),
  submitToBing: z.boolean(),
});
export const seoConfigPatch = patchOf(seoConfigSchema);
export type SeoConfig = z.infer<typeof seoConfigSchema>;

const pageTypes = z.enum(["home", "shop", "category", "product", "collection", "concierge", "policy", "custom"]);
const indexPolicy = z.enum(["index_follow", "noindex_follow", "noindex_nofollow"]);
const schemaType = z.enum(["WebSite", "Organization", "Product", "BreadcrumbList", "FAQPage", "Article", "CollectionPage"]);
const seoPageFields = z.object({
  path,
  type: pageTypes,
  title: z.string().trim().max(190),
  description: z.string().trim().max(500),
  ogTitle: z.string().max(190).nullable(),
  ogDescription: z.string().max(500).nullable(),
  ogImageUrl: optUrl.nullable(),
  canonical: absOrPath.nullable(),
  indexPolicy,
  keywords: z.array(z.string().trim().min(1).max(80)).max(30),
  schemaType: schemaType.nullable(),
});
export const seoPageCreate = patchOf(seoPageFields).extend({
  path, type: pageTypes.default("custom"), title: z.string().trim().max(190).default(""), description: z.string().trim().max(500).default(""),
  indexPolicy: indexPolicy.default("index_follow"), keywords: seoPageFields.shape.keywords.default([]),
});
export const seoPagePatch = patchOf(seoPageFields);
export const seoPageListQuery = pageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(100), type: pageTypes.optional() });

export const redirectStatus = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(410)]);
export const redirectCreate = z.object({
  from: path,
  /** ignored for 410 Gone */
  to: absOrPath.optional(),
  status: redirectStatus.default(301),
  enabled: z.boolean().default(true),
  note: z.string().max(500).nullable().optional(),
}).refine((r) => r.status === 410 || !!r.to, { message: "Where should it go?", path: ["to"] });
export const redirectPatch = z.object({ from: path, to: absOrPath, status: redirectStatus, enabled: z.boolean(), note: z.string().max(500).nullable() }).partial();
export const redirectListQuery = pageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(100), enabled: z.enum(["true", "false"]).transform((v) => v === "true").optional() });

const changefreq = z.enum(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);
export const sitemapCreate = z.object({
  /** absolute URL or a /path on the site */
  loc: absOrPath,
  changefreq: changefreq.default("weekly"),
  priority: z.number().min(0).max(1).default(0.5),
  /** false = keep this URL OUT of the sitemap (also hides auto-generated URLs) */
  included: z.boolean().default(true),
});
export const sitemapPatch = z.object({ loc: absOrPath, changefreq, priority: z.number().min(0).max(1), included: z.boolean() }).partial();

export const metaQuery = z.object({ path: z.string().min(1).max(500) });
export const hitsBody = z.object({ hits: z.array(z.object({ from: z.string().min(1).max(500), count: z.number().int().min(1).max(10_000).default(1) })).min(1).max(500) });

export type SeoPageCreate = z.infer<typeof seoPageCreate>;
export type SeoPagePatch = z.infer<typeof seoPagePatch>;
export type SeoPageListQuery = z.infer<typeof seoPageListQuery>;
export type RedirectCreate = z.infer<typeof redirectCreate>;
export type RedirectPatch = z.infer<typeof redirectPatch>;
export type RedirectListQuery = z.infer<typeof redirectListQuery>;
export type SitemapCreate = z.infer<typeof sitemapCreate>;
export type SitemapPatch = z.infer<typeof sitemapPatch>;
