import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import type { Prisma, Redirect, SeoPage } from "@/generated/prisma/client";
import { renderTokens, tokenContext } from "../content.common";
import {
  normalizePath, seoConfigSchema, type RedirectCreate, type RedirectListQuery, type RedirectPatch, type SeoConfig, type SeoPageCreate,
  type SeoPageListQuery, type SeoPagePatch, type SitemapCreate, type SitemapPatch,
} from "./seo.schemas";

/* ── global config (Setting row "seo") ───────────────────────────────── */

const GROUP = "seo";
const CONFIG_DEFAULTS: SeoConfig = {
  defaultTitleTemplate: "%s · ASL ORIGINALS",
  defaultDescription:
    "Curated luxury footwear, fashion, fragrance and accessories - shop the world's most sought-after brands with white-glove concierge sourcing.",
  siteName: "ASL ORIGINALS",
  siteUrl: env.WEB_URL,
  robotsTxt: ["User-agent: *", "Allow: /", "", "# private areas", "Disallow: /account", "Disallow: /checkout", "Disallow: /cart", "Disallow: /admin"].join("\n"),
  ogImageDefault: "",
  twitterHandle: "@asloriginals",
  gaMeasurementId: "",
  gscVerification: "",
  autoGenerateSitemap: true,
  submitToBing: false,
};

async function config(): Promise<SeoConfig> {
  const row = await prisma.setting.findUnique({ where: { group: GROUP } });
  return { ...CONFIG_DEFAULTS, ...((row?.value as Partial<SeoConfig>) ?? {}) };
}

const siteBase = (c: SeoConfig) => c.siteUrl.replace(/\/+$/, "");
const absolute = (c: SeoConfig, loc: string) => (/^https?:\/\//.test(loc) ? loc : `${siteBase(c)}${loc.startsWith("/") ? "" : "/"}${loc}`);
/** a redirect / canonical target on our own site → its path; external → null */
function internalPath(c: SeoConfig, to: string) {
  if (to.startsWith("/")) return normalizePath(to);
  try {
    const u = new URL(to);
    return u.host === new URL(c.siteUrl).host ? normalizePath(u.pathname) : null;
  } catch {
    return null;
  }
}
const applyTemplate = (c: SeoConfig, title: string) =>
  !title ? c.siteName : title.toLowerCase().includes(c.siteName.toLowerCase()) ? title : c.defaultTitleTemplate.replace("%s", title);
const truncate = (s: string | null | undefined, n = 160) => {
  const t = (s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const robotsOf = (p: string) => (p === "noindex_nofollow" ? "noindex,nofollow" : p === "noindex_follow" ? "noindex,follow" : "index,follow");

/* ── redirects cache (the web server polls GET /store/seo/redirects) ─── */

let redirectCache: { at: number; rows: { from: string; to: string | null; status: number }[] } | null = null;
const REDIRECT_TTL = 60_000;
const dropRedirectCache = () => {
  redirectCache = null;
};

/**
 * Refuse a redirect that would loop (A → B → … → A) or point at itself.
 * Only enabled, non-410 redirects that stay on our site take part.
 */
async function assertNoLoop(c: SeoConfig, candidate: { id?: string; from: string; to: string | null; status: number; enabled: boolean }) {
  if (!candidate.enabled || candidate.status === 410 || !candidate.to) return;
  const target = internalPath(c, candidate.to);
  if (target === candidate.from) throw ApiError.badRequest("VALIDATION_FAILED", "A redirect can't point to itself.", [{ path: "to", message: "Same as from" }]);
  if (!target) return;
  const all = await prisma.redirect.findMany({ where: { enabled: true, status: { not: 410 }, ...(candidate.id ? { id: { not: candidate.id } } : {}) } });
  const graph = new Map<string, string>();
  for (const r of all) {
    const t = internalPath(c, r.to);
    if (t) graph.set(r.from, t);
  }
  graph.set(candidate.from, target);
  const chain = [candidate.from];
  let at: string | undefined = target;
  while (at && chain.length < 50) {
    if (chain.includes(at)) {
      chain.push(at);
      throw ApiError.badRequest("VALIDATION_FAILED", `This redirect would create a loop: ${chain.join(" → ")}.`, [{ path: "to", message: "Redirect loop", chain }]);
    }
    chain.push(at);
    at = graph.get(at);
  }
}

const redirectOut = (r: Redirect) => ({
  id: r.id, from: r.from, to: r.to, status: r.status, enabled: r.enabled, hits: r.hits, lastHitAt: r.lastHitAt, note: r.note, createdAt: r.createdAt,
});
const seoPageOut = (p: SeoPage) => ({ ...p, keywords: (p.keywords as string[] | null) ?? [] });

async function loadRedirect(id: string) {
  const r = await prisma.redirect.findUnique({ where: { id } });
  if (!r) throw ApiError.notFound("Redirect");
  return r;
}

/* ── sitemap ─────────────────────────────────────────────────────────── */

type Url = { loc: string; lastmod?: Date | null; changefreq: string; priority: number };
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function sitemapUrls(c: SeoConfig): Promise<Url[]> {
  const [entries, noindex] = await Promise.all([
    prisma.sitemapEntry.findMany(),
    prisma.seoPage.findMany({ where: { indexPolicy: { not: "index_follow" } }, select: { path: true } }),
  ]);
  const excluded = new Set([...entries.filter((e) => !e.included).map((e) => absolute(c, e.loc)), ...noindex.map((p) => absolute(c, p.path))]);
  const urls = new Map<string, Url>();
  const add = (u: Url) => {
    const loc = absolute(c, u.loc);
    if (!excluded.has(loc) && !urls.has(loc)) urls.set(loc, { ...u, loc });
  };
  // manual entries first: their changefreq / priority win
  for (const e of entries.filter((x) => x.included)) add({ loc: e.loc, changefreq: e.changefreq, priority: e.priority });
  if (!c.autoGenerateSitemap) return [...urls.values()];

  const [products, categories, brands, collections, pages, posts] = await Promise.all([
    prisma.product.findMany({ where: { status: "active", deletedAt: null }, select: { handle: true, updatedAt: true } }),
    prisma.category.findMany({ where: { status: "active" }, select: { handle: true, updatedAt: true } }),
    prisma.brand.findMany({ where: { status: "active" }, select: { handle: true, updatedAt: true } }),
    prisma.collection.findMany({ where: { status: "active" }, select: { handle: true, updatedAt: true } }),
    prisma.page.findMany({ where: { status: "published", visibility: "public" }, select: { slug: true, updatedAt: true } }),
    prisma.blogPost.findMany({ where: { status: "published" }, select: { slug: true, updatedAt: true } }),
  ]);
  add({ loc: "/", changefreq: "daily", priority: 1 });
  add({ loc: "/shop", changefreq: "daily", priority: 0.9 });
  for (const x of collections) add({ loc: `/collection/${x.handle}`, lastmod: x.updatedAt, changefreq: "weekly", priority: 0.8 });
  for (const x of categories) add({ loc: `/shop/${x.handle}`, lastmod: x.updatedAt, changefreq: "weekly", priority: 0.8 });
  for (const x of brands) add({ loc: `/brands/${x.handle}`, lastmod: x.updatedAt, changefreq: "weekly", priority: 0.7 });
  for (const x of products) add({ loc: `/product/${x.handle}`, lastmod: x.updatedAt, changefreq: "weekly", priority: 0.8 });
  for (const x of pages) add({ loc: `/${x.slug}`, lastmod: x.updatedAt, changefreq: "monthly", priority: 0.5 });
  if (posts.length) add({ loc: "/blog", changefreq: "weekly", priority: 0.6 });
  for (const x of posts) add({ loc: `/blog/${x.slug}`, lastmod: x.updatedAt, changefreq: "monthly", priority: 0.6 });
  return [...urls.values()];
}

/* ── meta for a storefront path ──────────────────────────────────────── */

type Derived = { title: string; description: string; image?: string | null; type: string; schemaType?: string | null; found: boolean };

async function derive(c: SeoConfig, path: string): Promise<Derived> {
  const [, first, second] = path.split("/");
  if (path === "/") return { title: c.siteName, description: c.defaultDescription, type: "website", schemaType: "WebSite", found: true };
  if (first === "product" && second) {
    const p = await prisma.product.findFirst({
      where: { handle: second, status: "active", deletedAt: null },
      include: { brand: { select: { name: true } }, images: { orderBy: { position: "asc" }, take: 1 } },
    });
    if (p) return { title: p.seoTitle ?? `${p.brand.name} ${p.name}`, description: p.seoDescription ?? truncate(p.description), image: p.images[0]?.url, type: "product", schemaType: "Product", found: true };
  }
  if (first === "shop" && second) {
    const x = await prisma.category.findFirst({ where: { handle: second, status: "active" } });
    if (x) return { title: x.seoTitle ?? x.name, description: x.seoDescription ?? truncate(x.description), image: x.imageUrl, type: "website", schemaType: "CollectionPage", found: true };
  }
  if (first === "brands" && second) {
    const x = await prisma.brand.findFirst({ where: { handle: second, status: "active" } });
    if (x) return { title: x.seoTitle ?? x.name, description: x.seoDescription ?? truncate(x.description ?? x.tagline), image: x.logoUrl, type: "website", schemaType: "CollectionPage", found: true };
  }
  if (first === "collection" && second) {
    const x = await prisma.collection.findFirst({ where: { handle: second, status: "active" } });
    if (x) return { title: x.title, description: truncate(x.description), image: x.coverUrl, type: "website", schemaType: "CollectionPage", found: true };
  }
  if (first === "blog" && second) {
    const x = await prisma.blogPost.findFirst({ where: { slug: second, status: "published" } });
    if (x) return { title: x.seoTitle ?? x.title, description: x.seoDescription ?? truncate(x.excerpt), image: x.ogImage ?? x.coverUrl, type: "article", schemaType: "Article", found: true };
  }
  const page = await prisma.page.findFirst({ where: { slug: path.slice(1).toLowerCase(), status: "published" } });
  if (page) {
    const ctx = await tokenContext();
    const t = (v: string) => renderTokens(v, ctx, "text");
    return { title: t(page.seoTitle ?? page.title), description: t(page.seoDescription ?? page.subtitle ?? ""), image: page.ogImage ?? page.heroImage, type: "website", found: true };
  }
  return { title: "", description: c.defaultDescription, type: "website", found: false };
}

/* ── audit ───────────────────────────────────────────────────────────── */

type Finding = { severity: "error" | "warning" | "notice"; type: string; target: string; message: string; entity?: string; entityId?: string };

export const seoService = {
  config,

  async updateConfig(patch: Partial<SeoConfig>, by: string) {
    const before = await config();
    const after = seoConfigSchema.parse({ ...before, ...patch });
    await prisma.setting.upsert({ where: { group: GROUP }, create: { group: GROUP, value: after, updatedBy: by }, update: { value: after, updatedBy: by } });
    dropRedirectCache();
    return { before, after };
  },

  /* ── public ── */

  async robots() {
    const c = await config();
    const body = c.robotsTxt.trim();
    return /^\s*sitemap:/im.test(body) ? `${body}\n` : `${body}\n\nSitemap: ${siteBase(c)}/sitemap.xml\n`;
  },

  async sitemapXml() {
    const c = await config();
    const urls = await sitemapUrls(c);
    const rows = urls.map((u) =>
      [
        "  <url>",
        `    <loc>${xmlEsc(u.loc)}</loc>`,
        u.lastmod ? `    <lastmod>${u.lastmod.toISOString().slice(0, 10)}</lastmod>` : null,
        `    <changefreq>${u.changefreq}</changefreq>`,
        `    <priority>${u.priority.toFixed(1)}</priority>`,
        "  </url>",
      ].filter(Boolean).join("\n"),
    );
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`;
  },

  /** head tags for the web SSR: SeoPage overrides → entity (product, category, page, post …) → defaults */
  async meta(rawPath: string) {
    const c = await config();
    const path = normalizePath(rawPath);
    const [override, d, redirect] = await Promise.all([
      prisma.seoPage.findUnique({ where: { path } }),
      derive(c, path),
      prisma.redirect.findFirst({ where: { from: path, enabled: true } }),
    ]);
    const title = applyTemplate(c, override?.title || d.title);
    const description = truncate(override?.description || d.description, 300);
    const image = override?.ogImageUrl || d.image || c.ogImageDefault || null;
    const canonical = absolute(c, override?.canonical || path);
    return {
      path,
      found: !!override || d.found,
      title,
      description,
      canonical,
      robots: robotsOf(override?.indexPolicy ?? "index_follow"),
      keywords: (override?.keywords as string[] | null) ?? [],
      schemaType: override?.schemaType ?? d.schemaType ?? null,
      og: {
        title: override?.ogTitle || title,
        description: override?.ogDescription || description,
        image: image ? absolute(c, image) : null,
        type: d.type,
        url: canonical,
        siteName: c.siteName,
      },
      twitter: { card: image ? "summary_large_image" : "summary", site: c.twitterHandle || null },
      verification: { google: c.gscVerification || null },
      analytics: { gaMeasurementId: c.gaMeasurementId || null },
      redirect: redirect ? { to: redirect.to, status: redirect.status } : null,
    };
  },

  /** enabled redirects for the web server's middleware (cached 60 s) */
  async activeRedirects() {
    if (!redirectCache || Date.now() - redirectCache.at > REDIRECT_TTL) {
      const rows = await prisma.redirect.findMany({ where: { enabled: true }, orderBy: { from: "asc" } });
      redirectCache = { at: Date.now(), rows: rows.map((r) => ({ from: r.from, to: r.status === 410 ? null : r.to, status: r.status })) };
    }
    return { redirects: redirectCache.rows, ttlSeconds: REDIRECT_TTL / 1000 };
  },

  /** the web server reports hits in batches */
  async recordHits(hits: { from: string; count: number }[]) {
    const now = new Date();
    const merged = new Map<string, number>();
    for (const h of hits) merged.set(normalizePath(h.from), (merged.get(normalizePath(h.from)) ?? 0) + h.count);
    let recorded = 0;
    for (const [from, count] of merged) {
      const r = await prisma.redirect.updateMany({ where: { from, enabled: true }, data: { hits: { increment: count }, lastHitAt: now } });
      recorded += r.count ? count : 0;
    }
    return { recorded };
  },

  /* ── admin: SEO pages ── */

  async pages(q: SeoPageListQuery) {
    const where: Prisma.SeoPageWhereInput = {
      ...(q.type ? { type: q.type } : {}),
      ...(q.q ? { OR: [{ path: { contains: q.q } }, { title: { contains: q.q } }] } : {}),
    };
    const [rows, total, agg] = await Promise.all([
      prisma.seoPage.findMany({ where, orderBy: { path: "asc" }, ...paging(q) }),
      prisma.seoPage.count({ where }),
      prisma.seoPage.aggregate({ where, _sum: { impressions30d: true, clicks30d: true }, _avg: { avgPosition: true } }),
    ]);
    const imp = agg._sum.impressions30d ?? 0;
    const clk = agg._sum.clicks30d ?? 0;
    return withMeta(rows.map(seoPageOut), {
      ...pageMeta(q, total),
      kpis: { impressions30d: imp, clicks30d: clk, ctr: imp ? Math.round((clk / imp) * 1000) / 10 : 0, avgPosition: Math.round((agg._avg.avgPosition ?? 0) * 10) / 10 },
    });
  },

  async createPage(b: SeoPageCreate) {
    if (await prisma.seoPage.findUnique({ where: { path: b.path } })) throw ApiError.conflict("CONFLICT", `${b.path} already has SEO settings.`, [{ path: "path", message: "Already exists" }]);
    return seoPageOut(await prisma.seoPage.create({ data: { ...b, keywords: b.keywords } }));
  },

  async updatePage(id: string, patch: SeoPagePatch) {
    const before = await prisma.seoPage.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("SEO page");
    if (patch.path && patch.path !== before.path && (await prisma.seoPage.findUnique({ where: { path: patch.path } })))
      throw ApiError.conflict("CONFLICT", `${patch.path} already has SEO settings.`, [{ path: "path", message: "Already exists" }]);
    const after = await prisma.seoPage.update({ where: { id }, data: { ...patch, ...(patch.keywords ? { keywords: patch.keywords } : {}) } });
    return { before: seoPageOut(before), after: seoPageOut(after) };
  },

  async removePage(id: string) {
    const p = await prisma.seoPage.findUnique({ where: { id } });
    if (!p) throw ApiError.notFound("SEO page");
    await prisma.seoPage.delete({ where: { id } });
    return { id, path: p.path, deleted: true };
  },

  /* ── admin: redirects ── */

  async redirects(q: RedirectListQuery) {
    const where: Prisma.RedirectWhereInput = {
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
      ...(q.q ? { OR: [{ from: { contains: q.q } }, { to: { contains: q.q } }] } : {}),
    };
    const [rows, total, agg, active] = await Promise.all([
      prisma.redirect.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.redirect.count({ where }),
      prisma.redirect.aggregate({ _sum: { hits: true } }),
      prisma.redirect.count({ where: { enabled: true } }),
    ]);
    return withMeta(rows.map(redirectOut), { ...pageMeta(q, total), kpis: { active, hits: agg._sum.hits ?? 0 } });
  },

  async addRedirect(b: RedirectCreate) {
    const c = await config();
    if (await prisma.redirect.findUnique({ where: { from: b.from } })) throw ApiError.conflict("CONFLICT", `${b.from} already redirects somewhere.`, [{ path: "from", message: "Already exists" }]);
    const to = b.status === 410 ? (b.to ?? "") : b.to!;
    await assertNoLoop(c, { from: b.from, to, status: b.status, enabled: b.enabled });
    const r = await prisma.redirect.create({ data: { from: b.from, to, status: b.status, enabled: b.enabled, note: b.note ?? null } });
    dropRedirectCache();
    return redirectOut(r);
  },

  async updateRedirect(id: string, patch: RedirectPatch) {
    const c = await config();
    const before = await loadRedirect(id);
    const next = { ...before, ...patch, note: patch.note === undefined ? before.note : patch.note };
    if (patch.from && patch.from !== before.from && (await prisma.redirect.findUnique({ where: { from: patch.from } })))
      throw ApiError.conflict("CONFLICT", `${patch.from} already redirects somewhere.`, [{ path: "from", message: "Already exists" }]);
    await assertNoLoop(c, { id, from: next.from, to: next.to, status: next.status, enabled: next.enabled });
    const after = await prisma.redirect.update({ where: { id }, data: { from: next.from, to: next.to, status: next.status, enabled: next.enabled, note: next.note } });
    dropRedirectCache();
    return { before: redirectOut(before), after: redirectOut(after) };
  },

  async toggleRedirect(id: string) {
    const c = await config();
    const r = await loadRedirect(id);
    if (!r.enabled) await assertNoLoop(c, { id, from: r.from, to: r.to, status: r.status, enabled: true });
    const after = await prisma.redirect.update({ where: { id }, data: { enabled: !r.enabled } });
    dropRedirectCache();
    return redirectOut(after);
  },

  async removeRedirect(id: string) {
    const r = await loadRedirect(id);
    await prisma.redirect.delete({ where: { id } });
    dropRedirectCache();
    return { id, from: r.from, deleted: true };
  },

  /* ── admin: sitemap ── */

  async sitemapEntries() {
    const c = await config();
    const [entries, generated] = await Promise.all([prisma.sitemapEntry.findMany({ orderBy: { loc: "asc" } }), sitemapUrls(c)]);
    return withMeta(entries, { generatedCount: generated.length, autoGenerateSitemap: c.autoGenerateSitemap, sitemapUrl: `${siteBase(c)}/sitemap.xml` });
  },

  async addSitemapEntry(b: SitemapCreate) {
    const c = await config();
    const loc = absolute(c, b.loc);
    if (await prisma.sitemapEntry.findUnique({ where: { loc } })) throw ApiError.conflict("CONFLICT", "This URL is already listed.", [{ path: "loc", message: "Already exists" }]);
    return prisma.sitemapEntry.create({ data: { ...b, loc } });
  },

  async updateSitemapEntry(id: string, patch: SitemapPatch) {
    const c = await config();
    if (!(await prisma.sitemapEntry.findUnique({ where: { id } }))) throw ApiError.notFound("Sitemap entry");
    return prisma.sitemapEntry.update({ where: { id }, data: { ...patch, ...(patch.loc ? { loc: absolute(c, patch.loc) } : {}) } });
  },

  async toggleSitemapEntry(id: string) {
    const e = await prisma.sitemapEntry.findUnique({ where: { id } });
    if (!e) throw ApiError.notFound("Sitemap entry");
    return prisma.sitemapEntry.update({ where: { id }, data: { included: !e.included } });
  },

  async removeSitemapEntry(id: string) {
    if (!(await prisma.sitemapEntry.findUnique({ where: { id } }))) throw ApiError.notFound("Sitemap entry");
    await prisma.sitemapEntry.delete({ where: { id } });
    return { id, deleted: true };
  },

  /* ── admin: audit ── */

  async audit() {
    const c = await config();
    const f: Finding[] = [];
    const [seoPages, redirects, pages, posts, productsNoDesc] = await Promise.all([
      prisma.seoPage.findMany(),
      prisma.redirect.findMany({ where: { enabled: true } }),
      prisma.page.findMany({ where: { status: "published" }, select: { id: true, slug: true, title: true, seoTitle: true, seoDescription: true, visibility: true } }),
      prisma.blogPost.findMany({ where: { status: "published" }, select: { id: true, slug: true, seoTitle: true, seoDescription: true, excerpt: true } }),
      prisma.product.count({ where: { status: "active", deletedAt: null, seoDescription: null, OR: [{ description: null }, { description: "" }] } }),
    ]);

    for (const p of seoPages) {
      if (!p.title.trim()) f.push({ severity: "error", type: "missing_title", target: p.path, message: "Missing <title>", entity: "seo_page", entityId: p.id });
      else if (applyTemplate(c, p.title).length > 60) f.push({ severity: "notice", type: "long_title", target: p.path, message: `Title is ${applyTemplate(c, p.title).length} characters with the site name (aim for ≤ 60)`, entity: "seo_page", entityId: p.id });
      if (!p.description.trim()) f.push({ severity: "warning", type: "missing_description", target: p.path, message: "Missing meta description", entity: "seo_page", entityId: p.id });
      else if (p.description.length > 160) f.push({ severity: "warning", type: "long_description", target: p.path, message: `Description is ${p.description.length} characters (search engines cut at ~160)`, entity: "seo_page", entityId: p.id });
    }
    for (const p of pages) {
      if (p.visibility === "members") continue;
      if (!p.seoTitle) f.push({ severity: "notice", type: "missing_title", target: `/${p.slug}`, message: `No SEO title — "${p.title}" is used`, entity: "page", entityId: p.id });
      if (!p.seoDescription) f.push({ severity: "warning", type: "missing_description", target: `/${p.slug}`, message: "Page has no meta description", entity: "page", entityId: p.id });
      else if (p.seoDescription.length > 160) f.push({ severity: "warning", type: "long_description", target: `/${p.slug}`, message: `Description is ${p.seoDescription.length} characters`, entity: "page", entityId: p.id });
    }
    for (const p of posts) {
      if (!p.seoDescription && !p.excerpt) f.push({ severity: "warning", type: "missing_description", target: `/blog/${p.slug}`, message: "Post has no meta description or excerpt", entity: "blog_post", entityId: p.id });
      else if ((p.seoDescription ?? "").length > 160) f.push({ severity: "warning", type: "long_description", target: `/blog/${p.slug}`, message: `Description is ${p.seoDescription!.length} characters`, entity: "blog_post", entityId: p.id });
    }
    if (productsNoDesc) f.push({ severity: "notice", type: "missing_description", target: "/product/*", message: `${productsNoDesc} active product(s) have no description to use as meta description`, entity: "product" });

    // redirects: chains, loops, targets that no longer exist
    const graph = new Map(redirects.filter((r) => r.status !== 410).map((r) => [r.from, internalPath(c, r.to)]));
    const pageSlugs = new Set(pages.map((p) => `/${p.slug}`));
    for (const r of redirects) {
      if (r.status === 410) continue;
      const to = internalPath(c, r.to);
      if (!to) continue;
      if (to === r.from) {
        f.push({ severity: "error", type: "broken_redirect", target: r.from, message: "Redirects to itself", entity: "redirect", entityId: r.id });
        continue;
      }
      if (graph.has(to)) {
        const seen = [r.from, to];
        let at = graph.get(to) ?? null;
        while (at && !seen.includes(at) && seen.length < 20) {
          seen.push(at);
          at = graph.get(at) ?? null;
        }
        const loop = !!at && seen.includes(at);
        f.push({
          severity: loop ? "error" : "warning", type: loop ? "redirect_loop" : "redirect_chain", target: r.from, entity: "redirect", entityId: r.id,
          message: loop ? `Redirect loop: ${[...seen, at].join(" → ")}` : `Redirect chain: ${seen.join(" → ")} — point ${r.from} straight to the final URL`,
        });
        continue;
      }
      const [, first, second] = to.split("/");
      let exists = true;
      if (first === "product" && second) exists = !!(await prisma.product.findFirst({ where: { handle: second, status: "active", deletedAt: null }, select: { id: true } }));
      else if (first === "shop" && second) exists = !!(await prisma.category.findFirst({ where: { handle: second, status: "active" }, select: { id: true } }));
      else if (first === "brands" && second) exists = !!(await prisma.brand.findFirst({ where: { handle: second, status: "active" }, select: { id: true } }));
      else if (first === "collection" && second) exists = !!(await prisma.collection.findFirst({ where: { handle: second, status: "active" }, select: { id: true } }));
      else if (first === "blog" && second) exists = !!(await prisma.blogPost.findFirst({ where: { slug: second, status: "published" }, select: { id: true } }));
      else if (first === "customer-care") exists = pageSlugs.has(to);
      if (!exists) f.push({ severity: "error", type: "broken_redirect", target: r.from, message: `Target ${to} doesn't exist or isn't published`, entity: "redirect", entityId: r.id });
    }

    // duplicate canonicals
    const canon = new Map<string, string[]>();
    for (const p of seoPages) {
      const k = absolute(c, p.canonical || p.path);
      canon.set(k, [...(canon.get(k) ?? []), p.path]);
    }
    for (const [k, paths] of canon)
      if (paths.length > 1) f.push({ severity: "warning", type: "duplicate_canonical", target: paths.join(", "), message: `${paths.length} pages share the canonical ${k}` });

    const n = (s: Finding["severity"]) => f.filter((x) => x.severity === s).length;
    const order = { error: 0, warning: 1, notice: 2 };
    return {
      summary: { errors: n("error"), warnings: n("warning"), notices: n("notice"), score: Math.max(0, 100 - n("error") * 10 - n("warning") * 3 - n("notice")) },
      findings: f.sort((a, b) => order[a.severity] - order[b.severity]),
    };
  },
};
