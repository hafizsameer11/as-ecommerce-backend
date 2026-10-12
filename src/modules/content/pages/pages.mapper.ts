import type { Page } from "@/generated/prisma/client";
import { renderTokens, type TokenContext } from "../content.common";
import type { PageBlock } from "./pages.schemas";

export const pagePath = (slug: string) => `/${slug}`;

export const pageAdmin = (p: Page) => ({
  id: p.id,
  title: p.title,
  slug: p.slug,
  path: pagePath(p.slug),
  template: p.template,
  status: p.status,
  visibility: p.visibility,
  subtitle: p.subtitle,
  author: p.author,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
  ogImage: p.ogImage,
  heroImage: p.heroImage,
  showInHeader: p.showInHeader,
  showInFooter: p.showInFooter,
  tags: (p.tags as string[] | null) ?? [],
  blocks: (p.blocks as PageBlock[] | null) ?? [],
  views30d: p.views30d,
  publishedAt: p.publishedAt,
  scheduledFor: p.scheduledFor,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** `body` fields are HTML (rendered with escaping), everything else is plain text */
function renderValue(key: string, v: unknown, ctx: TokenContext): unknown {
  if (typeof v === "string") return renderTokens(v, ctx, key === "body" ? "html" : "text");
  if (Array.isArray(v)) return v.map((x) => renderValue(key, x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderValue(k, x, ctx)]));
  return v;
}
export const renderBlocks = (blocks: PageBlock[], ctx: TokenContext) => blocks.map((b) => renderValue("", b, ctx) as PageBlock);

/** what asl-web / asl-mobile render */
export const pageStore = (p: Page, blocks: PageBlock[], ctx: TokenContext) => ({
  id: p.id,
  slug: p.slug,
  path: pagePath(p.slug),
  title: renderTokens(p.title, ctx, "text"),
  subtitle: p.subtitle ? renderTokens(p.subtitle, ctx, "text") : null,
  template: p.template,
  visibility: p.visibility,
  heroImage: p.heroImage,
  tags: (p.tags as string[] | null) ?? [],
  seo: {
    title: renderTokens(p.seoTitle ?? p.title, ctx, "text"),
    description: p.seoDescription ? renderTokens(p.seoDescription, ctx, "text") : null,
    ogImage: p.ogImage,
  },
  blocks: renderBlocks(blocks, ctx),
  publishedAt: p.publishedAt,
  updatedAt: p.updatedAt,
});
