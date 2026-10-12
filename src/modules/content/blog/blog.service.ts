import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import type { BlogAuthor, BlogCategory, BlogPost, Prisma } from "@/generated/prisma/client";
import { logger } from "@/core/utils/logger";
import { mediaService } from "../media/media.service";
import { cleanRich, cleanText, freeSlug, slugify, statusFields, urlsIn } from "../content.common";
import type {
  AuthorCreate, AuthorPatch, CategoryCreate, CategoryPatch, PostCreate, PostListQuery, PostPatch, PostStatusBody, StoreBlogQuery,
} from "./blog.schemas";

type PostFull = BlogPost & { category: BlogCategory; author: BlogAuthor };

const tagsOf = (p: BlogPost) => (p.tags as string[] | null) ?? [];
/** ~200 words a minute */
const readingMinutes = (content: string) => Math.max(1, Math.round(content.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length / 200));

const categoryOut = (c: BlogCategory & { _count?: { posts: number } }) => ({ id: c.id, name: c.name, slug: c.slug, colour: c.colour, postCount: c._count?.posts });
const authorOut = (a: BlogAuthor & { _count?: { posts: number } }) => ({ id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl, postCount: a._count?.posts });

const postAdmin = (p: BlogPost) => ({
  id: p.id, title: p.title, slug: p.slug, excerpt: p.excerpt, content: p.content, coverUrl: p.coverUrl, categoryId: p.categoryId, authorId: p.authorId,
  tags: tagsOf(p), status: p.status, featured: p.featured, readingMinutes: p.readingMinutes, seoTitle: p.seoTitle, seoDescription: p.seoDescription,
  ogImage: p.ogImage, views30d: p.views30d, likes: p.likes, comments: 0, publishedAt: p.publishedAt, scheduledFor: p.scheduledFor,
  createdAt: p.createdAt, updatedAt: p.updatedAt,
});

const postCard = (p: PostFull) => ({
  id: p.id, title: p.title, slug: p.slug, path: `/blog/${p.slug}`, excerpt: p.excerpt, coverUrl: p.coverUrl, tags: tagsOf(p), featured: p.featured,
  readingMinutes: p.readingMinutes, likes: p.likes, publishedAt: p.publishedAt,
  category: { id: p.category.id, name: p.category.name, slug: p.category.slug, colour: p.category.colour },
  author: { id: p.author.id, name: p.author.name, role: p.author.role, avatarUrl: p.author.avatarUrl },
});

const live: Prisma.BlogPostWhereInput = { status: "published" };

async function loadPost(id: string) {
  const p = await prisma.blogPost.findUnique({ where: { id } });
  if (!p) throw ApiError.notFound("Post");
  return p;
}
const postSlugTaken = async (slug: string) => !!(await prisma.blogPost.findUnique({ where: { slug }, select: { id: true } }));
const catSlugTaken = async (slug: string) => !!(await prisma.blogCategory.findUnique({ where: { slug }, select: { id: true } }));

async function assertRefs(categoryId?: string, authorId?: string) {
  if (categoryId && !(await prisma.blogCategory.findUnique({ where: { id: categoryId }, select: { id: true } })))
    throw ApiError.badRequest("VALIDATION_FAILED", "Pick an existing category.", [{ path: "categoryId", message: "Not found" }]);
  if (authorId && !(await prisma.blogAuthor.findUnique({ where: { id: authorId }, select: { id: true } })))
    throw ApiError.badRequest("VALIDATION_FAILED", "Pick an existing author.", [{ path: "authorId", message: "Not found" }]);
}

const syncMedia = (p: BlogPost) => mediaService.syncUsage("blog", p.id, [p.coverUrl, p.ogImage, ...urlsIn(p.content)]);

export const blogService = {
  /* ── store ── */

  async storeList(q: StoreBlogQuery) {
    const where: Prisma.BlogPostWhereInput = {
      ...live,
      ...(q.category ? { category: { slug: q.category } } : {}),
      ...(q.featured !== undefined ? { featured: q.featured } : {}),
      ...(q.tag ? { tags: { array_contains: [q.tag] } } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { excerpt: { contains: q.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.blogPost.findMany({ where, include: { category: true, author: true }, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], ...paging(q) }),
      prisma.blogPost.count({ where }),
    ]);
    return withMeta(rows.map(postCard), pageMeta(q, total));
  },

  async storeCategories() {
    const cats = await prisma.blogCategory.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { posts: { where: live } } } } });
    return cats.filter((c) => c._count.posts > 0).map(categoryOut);
  },

  async storeBySlug(slug: string) {
    const p = await prisma.blogPost.findUnique({ where: { slug }, include: { category: true, author: true } });
    if (!p || p.status !== "published") throw ApiError.notFound("Post");
    prisma.blogPost.update({ where: { id: p.id }, data: { views30d: { increment: 1 } } }).catch((err) => logger.warn({ err }, "blog view count failed"));
    const related = await prisma.blogPost.findMany({
      where: { ...live, categoryId: p.categoryId, id: { not: p.id } },
      include: { category: true, author: true },
      orderBy: { publishedAt: "desc" },
      take: 3,
    });
    return {
      ...postCard(p),
      content: p.content,
      seo: { title: p.seoTitle ?? p.title, description: p.seoDescription ?? p.excerpt, ogImage: p.ogImage ?? p.coverUrl },
      related: related.map(postCard),
    };
  },

  async like(id: string) {
    const r = await prisma.blogPost.updateMany({ where: { id, ...live }, data: { likes: { increment: 1 } } });
    if (!r.count) throw ApiError.notFound("Post");
    const p = await prisma.blogPost.findUniqueOrThrow({ where: { id }, select: { likes: true } });
    return { id, likes: p.likes };
  },

  /* ── admin: posts ── */

  async list(q: PostListQuery) {
    const where: Prisma.BlogPostWhereInput = {
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.authorId ? { authorId: q.authorId } : {}),
      ...(q.featured !== undefined ? { featured: q.featured } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { slug: { contains: q.q } }, { excerpt: { contains: q.q } }] } : {}),
    };
    const filtered = { ...where, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, counts, agg] = await Promise.all([
      prisma.blogPost.findMany({ where: filtered, orderBy: { updatedAt: "desc" }, ...paging(q) }),
      prisma.blogPost.count({ where: filtered }),
      prisma.blogPost.groupBy({ by: ["status"], where, _count: true }),
      prisma.blogPost.aggregate({ where, _sum: { views30d: true, likes: true } }),
    ]);
    const n = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    const tabs = { all: counts.reduce((a, c) => a + c._count, 0), published: n("published"), draft: n("draft"), scheduled: n("scheduled"), archived: n("archived") };
    return withMeta(rows.map(postAdmin), { ...pageMeta(q, total), tabs, kpis: { published: tabs.published, views30d: agg._sum.views30d ?? 0, likes: agg._sum.likes ?? 0 } });
  },

  async get(id: string) {
    return postAdmin(await loadPost(id));
  },

  async create(b: PostCreate) {
    await assertRefs(b.categoryId, b.authorId);
    const slug = b.slug ?? (await freeSlug(slugify(b.title), postSlugTaken));
    if (b.slug && (await postSlugTaken(slug))) throw ApiError.conflict("CONFLICT", "Another post already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    const content = cleanRich(b.content);
    const p = await prisma.blogPost.create({
      data: {
        title: cleanText(b.title), slug, excerpt: cleanText(b.excerpt), content, coverUrl: b.coverUrl ?? null, categoryId: b.categoryId, authorId: b.authorId,
        tags: b.tags, status: b.status, featured: b.featured, readingMinutes: b.readingMinutes ?? readingMinutes(content),
        seoTitle: b.seoTitle ?? null, seoDescription: b.seoDescription ?? null, ogImage: b.ogImage ?? null,
        publishedAt: b.status === "published" ? new Date() : null,
      },
    });
    await syncMedia(p);
    return postAdmin(p);
  },

  async update(id: string, patch: PostPatch) {
    const before = await loadPost(id);
    await assertRefs(patch.categoryId, patch.authorId);
    if (patch.slug && patch.slug !== before.slug && (await postSlugTaken(patch.slug)))
      throw ApiError.conflict("CONFLICT", "Another post already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    const content = patch.content !== undefined ? cleanRich(patch.content) : undefined;
    const after = await prisma.blogPost.update({
      where: { id },
      data: {
        ...patch,
        ...(patch.title !== undefined ? { title: cleanText(patch.title) } : {}),
        ...(patch.excerpt !== undefined ? { excerpt: cleanText(patch.excerpt) } : {}),
        ...(content !== undefined ? { content, ...(patch.readingMinutes === undefined ? { readingMinutes: readingMinutes(content) } : {}) } : {}),
      },
    });
    await syncMedia(after);
    return { before: postAdmin(before), after: postAdmin(after) };
  },

  async remove(id: string) {
    const p = await loadPost(id);
    await prisma.blogPost.delete({ where: { id } });
    await mediaService.syncUsage("blog", id, []);
    return { id, title: p.title, deleted: true };
  },

  async duplicate(id: string) {
    const src = await loadPost(id);
    const slug = await freeSlug(`${src.slug}-copy`, postSlugTaken);
    const p = await prisma.blogPost.create({
      data: {
        title: `${src.title} (copy)`, slug, excerpt: src.excerpt, content: src.content, coverUrl: src.coverUrl, categoryId: src.categoryId, authorId: src.authorId,
        tags: src.tags ?? [], status: "draft", featured: false, readingMinutes: src.readingMinutes, seoTitle: src.seoTitle, seoDescription: src.seoDescription, ogImage: src.ogImage,
      },
    });
    await syncMedia(p);
    return postAdmin(p);
  },

  async setStatus(id: string, b: PostStatusBody) {
    const before = await loadPost(id);
    const after = await prisma.blogPost.update({ where: { id }, data: statusFields(b.status, b.scheduledFor, before) });
    return { before: postAdmin(before), after: postAdmin(after) };
  },

  async toggleFeatured(id: string) {
    const p = await loadPost(id);
    return postAdmin(await prisma.blogPost.update({ where: { id }, data: { featured: !p.featured } }));
  },

  /** content.publish-scheduled */
  async publishDue(now = new Date()) {
    const due = await prisma.blogPost.findMany({ where: { status: "scheduled", scheduledFor: { lte: now } }, select: { id: true, scheduledFor: true } });
    for (const p of due)
      await prisma.blogPost.updateMany({ where: { id: p.id, status: "scheduled" }, data: { status: "published", publishedAt: p.scheduledFor ?? now, scheduledFor: null } });
    return due.length;
  },

  /* ── admin: categories ── */

  async categories() {
    return (await prisma.blogCategory.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { posts: true } } } })).map(categoryOut);
  },
  async createCategory(b: CategoryCreate) {
    const slug = b.slug ?? (await freeSlug(slugify(b.name), catSlugTaken));
    if (b.slug && (await catSlugTaken(slug))) throw ApiError.conflict("CONFLICT", "Another category already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    return categoryOut(await prisma.blogCategory.create({ data: { name: cleanText(b.name), slug, colour: b.colour ?? "#0f0f0f" } }));
  },
  async updateCategory(id: string, patch: CategoryPatch) {
    const before = await prisma.blogCategory.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Category");
    if (patch.slug && patch.slug !== before.slug && (await catSlugTaken(patch.slug)))
      throw ApiError.conflict("CONFLICT", "Another category already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    return categoryOut(await prisma.blogCategory.update({ where: { id }, data: { ...patch, ...(patch.name ? { name: cleanText(patch.name) } : {}) } }));
  },
  async removeCategory(id: string) {
    const c = await prisma.blogCategory.findUnique({ where: { id }, include: { _count: { select: { posts: true } } } });
    if (!c) throw ApiError.notFound("Category");
    if (c._count.posts) throw ApiError.conflict("CONFLICT", `${c._count.posts} post(s) use this category. Move them first.`);
    await prisma.blogCategory.delete({ where: { id } });
    return { id, name: c.name, deleted: true };
  },

  /* ── admin: authors ── */

  async authors() {
    return (await prisma.blogAuthor.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { posts: true } } } })).map(authorOut);
  },
  async createAuthor(b: AuthorCreate) {
    const a = await prisma.blogAuthor.create({ data: { name: cleanText(b.name), role: cleanText(b.role), avatarUrl: b.avatarUrl ?? null } });
    await mediaService.syncUsage("blog.author", a.id, [a.avatarUrl]);
    return authorOut(a);
  },
  async updateAuthor(id: string, patch: AuthorPatch) {
    if (!(await prisma.blogAuthor.findUnique({ where: { id }, select: { id: true } }))) throw ApiError.notFound("Author");
    const a = await prisma.blogAuthor.update({ where: { id }, data: patch });
    await mediaService.syncUsage("blog.author", a.id, [a.avatarUrl]);
    return authorOut(a);
  },
  async removeAuthor(id: string) {
    const a = await prisma.blogAuthor.findUnique({ where: { id }, include: { _count: { select: { posts: true } } } });
    if (!a) throw ApiError.notFound("Author");
    if (a._count.posts) throw ApiError.conflict("CONFLICT", `${a._count.posts} post(s) are by this author. Reassign them first.`);
    await prisma.blogAuthor.delete({ where: { id } });
    await mediaService.syncUsage("blog.author", id, []);
    return { id, name: a.name, deleted: true };
  },
};
