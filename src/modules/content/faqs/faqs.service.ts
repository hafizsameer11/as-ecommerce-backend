import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import type { FaqCategory, FaqItem, Prisma } from "@/generated/prisma/client";
import { cleanHtml, cleanText, freeSlug, renderTokens, slugify, tokenContext, type TokenContext } from "../content.common";
import type { CategoryCreate, CategoryPatch, ItemCreate, ItemListQuery, ItemPatch, StoreFaqQuery } from "./faqs.schemas";

const tagsOf = (i: FaqItem) => (i.tags as string[] | null) ?? [];

const categoryOut = (c: FaqCategory & { _count?: { items: number } }) => ({
  id: c.id, name: c.name, slug: c.slug, description: c.description, icon: c.icon, order: c.position, itemCount: c._count?.items,
});

const itemAdmin = (i: FaqItem) => ({
  id: i.id, categoryId: i.categoryId, question: i.question, answer: i.answer, status: i.status, order: i.position, featured: i.featured,
  tags: tagsOf(i), views30d: i.views30d, helpful: i.helpful, notHelpful: i.notHelpful, author: i.author, updatedAt: i.updatedAt,
});

const itemStore = (i: FaqItem & { category: FaqCategory }, ctx: TokenContext) => ({
  id: i.id,
  question: renderTokens(i.question, ctx, "text"),
  answer: renderTokens(i.answer, ctx, "html"),
  category: { id: i.category.id, slug: i.category.slug, name: i.category.name },
  featured: i.featured,
  tags: tagsOf(i),
  helpful: i.helpful,
  notHelpful: i.notHelpful,
});

async function loadItem(id: string) {
  const i = await prisma.faqItem.findUnique({ where: { id } });
  if (!i) throw ApiError.notFound("Question");
  return i;
}
async function loadCategory(id: string) {
  const c = await prisma.faqCategory.findUnique({ where: { id } });
  if (!c) throw ApiError.notFound("FAQ category");
  return c;
}
const slugTaken = async (slug: string) => !!(await prisma.faqCategory.findUnique({ where: { slug }, select: { id: true } }));

/** swap `position` with the neighbour in the given direction */
async function swap<T extends { id: string; position: number }>(list: T[], id: string, dir: -1 | 1, write: (id: string, position: number) => Prisma.PrismaPromise<unknown>) {
  const ordered = list.map((x, i) => ({ ...x, position: i }));
  const i = ordered.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ordered.length) return;
  [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  await prisma.$transaction(ordered.map((x, k) => write(x.id, k)));
}

export const faqsService = {
  /* ── store ── */

  async storeCategories() {
    const cats = await prisma.faqCategory.findMany({
      orderBy: { position: "asc" },
      include: { _count: { select: { items: { where: { status: "published" } } } } },
    });
    return cats.filter((c) => c._count.items > 0).map(categoryOut);
  },

  async storeList(q: StoreFaqQuery) {
    const items = await prisma.faqItem.findMany({
      where: {
        status: "published",
        ...(q.category && q.category !== "all" ? { category: { slug: q.category } } : {}),
        ...(q.featured !== undefined ? { featured: q.featured } : {}),
        ...(q.q ? { OR: [{ question: { contains: q.q } }, { answer: { contains: q.q } }] } : {}),
      },
      include: { category: true },
      orderBy: [{ category: { position: "asc" } }, { position: "asc" }],
    });
    const ctx = await tokenContext();
    return items.map((i) => itemStore(i, ctx));
  },

  async feedback(id: string, helpful: boolean) {
    const i = await prisma.faqItem.findUnique({ where: { id }, select: { status: true } });
    if (!i || i.status !== "published") throw ApiError.notFound("Question");
    const after = await prisma.faqItem.update({ where: { id }, data: helpful ? { helpful: { increment: 1 } } : { notHelpful: { increment: 1 } } });
    return { id, helpful: after.helpful, notHelpful: after.notHelpful };
  },

  async view(id: string) {
    const r = await prisma.faqItem.updateMany({ where: { id, status: "published" }, data: { views30d: { increment: 1 } } });
    if (!r.count) throw ApiError.notFound("Question");
    return { id, viewed: true };
  },

  /* ── admin: categories ── */

  async categories() {
    const cats = await prisma.faqCategory.findMany({ orderBy: { position: "asc" }, include: { _count: { select: { items: true } } } });
    return cats.map(categoryOut);
  },

  async createCategory(b: CategoryCreate) {
    const slug = b.slug ?? (await freeSlug(slugify(b.name), slugTaken));
    if (b.slug && (await slugTaken(slug))) throw ApiError.conflict("CONFLICT", "Another category already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    const last = await prisma.faqCategory.aggregate({ _max: { position: true } });
    const c = await prisma.faqCategory.create({
      data: { name: cleanText(b.name), slug, description: b.description ?? null, icon: b.icon ?? "HelpCircle", position: (last._max.position ?? -1) + 1 },
    });
    return categoryOut(c);
  },

  async updateCategory(id: string, patch: CategoryPatch) {
    const before = await loadCategory(id);
    if (patch.slug && patch.slug !== before.slug && (await slugTaken(patch.slug)))
      throw ApiError.conflict("CONFLICT", "Another category already uses this slug.", [{ path: "slug", message: "Already in use" }]);
    const after = await prisma.faqCategory.update({ where: { id }, data: { ...patch, ...(patch.name ? { name: cleanText(patch.name) } : {}) } });
    return { before: categoryOut(before), after: categoryOut(after) };
  },

  /** deleting a category deletes its questions (admin confirms in the UI) */
  async removeCategory(id: string) {
    const c = await loadCategory(id);
    const items = await prisma.faqItem.count({ where: { categoryId: id } });
    await prisma.faqCategory.delete({ where: { id } });
    return { id, name: c.name, deletedItems: items };
  },

  async moveCategory(id: string, dir: -1 | 1) {
    await loadCategory(id);
    const all = await prisma.faqCategory.findMany({ orderBy: { position: "asc" }, select: { id: true, position: true } });
    await swap(all, id, dir, (cid, position) => prisma.faqCategory.update({ where: { id: cid }, data: { position } }));
    return this.categories();
  },

  /* ── admin: items ── */

  async items(q: ItemListQuery) {
    const where: Prisma.FaqItemWhereInput = {
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.status !== "all" ? { status: q.status } : {}),
      ...(q.featured !== undefined ? { featured: q.featured } : {}),
      ...(q.q ? { OR: [{ question: { contains: q.q } }, { answer: { contains: q.q } }] } : {}),
    };
    const [rows, total, agg] = await Promise.all([
      prisma.faqItem.findMany({ where, orderBy: [{ category: { position: "asc" } }, { position: "asc" }], ...paging(q) }),
      prisma.faqItem.count({ where }),
      prisma.faqItem.aggregate({ where, _sum: { views30d: true, helpful: true, notHelpful: true } }),
    ]);
    const h = agg._sum.helpful ?? 0;
    const nh = agg._sum.notHelpful ?? 0;
    return withMeta(rows.map(itemAdmin), {
      ...pageMeta(q, total),
      kpis: { views30d: agg._sum.views30d ?? 0, helpful: h, notHelpful: nh, helpfulRate: h + nh ? Math.round((h / (h + nh)) * 100) : null },
    });
  },

  async getItem(id: string) {
    return itemAdmin(await loadItem(id));
  },

  async createItem(b: ItemCreate, author: string) {
    await loadCategory(b.categoryId);
    const last = await prisma.faqItem.aggregate({ where: { categoryId: b.categoryId }, _max: { position: true } });
    const i = await prisma.faqItem.create({
      data: {
        categoryId: b.categoryId, question: cleanText(b.question), answer: cleanHtml(b.answer), status: b.status, featured: b.featured,
        tags: b.tags, author, position: (last._max.position ?? -1) + 1,
      },
    });
    return itemAdmin(i);
  },

  async updateItem(id: string, patch: ItemPatch) {
    const before = await loadItem(id);
    const moving = patch.categoryId && patch.categoryId !== before.categoryId;
    if (moving) await loadCategory(patch.categoryId!);
    const last = moving ? await prisma.faqItem.aggregate({ where: { categoryId: patch.categoryId }, _max: { position: true } }) : null;
    const after = await prisma.faqItem.update({
      where: { id },
      data: {
        ...patch,
        ...(patch.question !== undefined ? { question: cleanText(patch.question) } : {}),
        ...(patch.answer !== undefined ? { answer: cleanHtml(patch.answer) } : {}),
        ...(last ? { position: (last._max.position ?? -1) + 1 } : {}),
      },
    });
    return { before: itemAdmin(before), after: itemAdmin(after) };
  },

  async removeItem(id: string) {
    const i = await loadItem(id);
    await prisma.faqItem.delete({ where: { id } });
    return { id, question: i.question, deleted: true };
  },

  async duplicateItem(id: string, author: string) {
    const src = await loadItem(id);
    await prisma.faqItem.updateMany({ where: { categoryId: src.categoryId, position: { gt: src.position } }, data: { position: { increment: 1 } } });
    const i = await prisma.faqItem.create({
      data: {
        categoryId: src.categoryId, question: `${src.question} (copy)`.slice(0, 500), answer: src.answer, status: "draft", featured: false,
        tags: src.tags ?? [], author, position: src.position + 1,
      },
    });
    return itemAdmin(i);
  },

  async setItemStatus(id: string, status: "published" | "draft" | "archived") {
    await loadItem(id);
    return itemAdmin(await prisma.faqItem.update({ where: { id }, data: { status } }));
  },

  async toggleFeatured(id: string) {
    const i = await loadItem(id);
    return itemAdmin(await prisma.faqItem.update({ where: { id }, data: { featured: !i.featured } }));
  },

  async moveItem(id: string, dir: -1 | 1) {
    const i = await loadItem(id);
    const siblings = await prisma.faqItem.findMany({ where: { categoryId: i.categoryId }, orderBy: { position: "asc" }, select: { id: true, position: true } });
    await swap(siblings, id, dir, (iid, position) => prisma.faqItem.update({ where: { id: iid }, data: { position } }));
    return itemAdmin(await loadItem(id));
  },
};
