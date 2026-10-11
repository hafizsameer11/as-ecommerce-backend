import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { slugify } from "@/core/utils/slug";

const includeSubs = { subcategories: { orderBy: { position: "asc" as const } } };

async function productCounts() {
  const [byCat, bySub] = await Promise.all([
    prisma.product.groupBy({ by: ["categoryId"], where: { status: "active", deletedAt: null }, _count: true }),
    prisma.product.groupBy({ by: ["subcategoryId"], where: { status: "active", deletedAt: null }, _count: true }),
  ]);
  return { cat: new Map(byCat.map((r) => [r.categoryId, r._count])), sub: new Map(bySub.map((r) => [r.subcategoryId, r._count])) };
}

type CatRow = Awaited<ReturnType<typeof prisma.category.findFirstOrThrow<{ include: typeof includeSubs }>>>;

function dto(c: CatRow, counts: Awaited<ReturnType<typeof productCounts>>, admin = false) {
  return {
    id: c.id,
    handle: c.handle,
    name: c.name,
    description: c.description,
    image: c.imageUrl,
    icon: c.icon,
    featured: c.featured,
    itemCount: counts.cat.get(c.id) ?? 0,
    ...(admin ? { status: c.status, position: c.position, concierge: c.concierge, seoTitle: c.seoTitle, seoDescription: c.seoDescription, createdAt: c.createdAt, updatedAt: c.updatedAt } : {}),
    subcategories: c.subcategories
      .filter((s) => admin || s.status === "active")
      .map((s) => ({ id: s.id, handle: s.handle, name: s.name, image: s.imageUrl, productCount: counts.sub.get(s.id) ?? 0, ...(admin ? { status: s.status, updatedAt: s.updatedAt } : {}) })),
  };
}

async function find(idOrHandle: string) {
  const c = await prisma.category.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] }, include: includeSubs });
  if (!c) throw ApiError.notFound("Category");
  return c;
}

export const categoriesService = {
  async storeList() {
    const [rows, counts] = await Promise.all([prisma.category.findMany({ where: { status: "active" }, orderBy: { position: "asc" }, include: includeSubs }), productCounts()]);
    const list = rows.map((c) => dto(c, counts));
    // "Sale" is a virtual category the apps show next to the real ones
    const saleCount = await prisma.product.count({ where: { status: "active", deletedAt: null, compareAtPrice: { not: null } } });
    return [...list, { id: "sale", handle: "sale", name: "Sale", description: "Selected pieces at reduced prices.", image: null, icon: null, featured: false, itemCount: saleCount, subcategories: list.map((c) => ({ id: `sale-${c.handle}`, handle: c.handle, name: c.name, image: null, productCount: 0 })) }];
  },
  async storeGet(handle: string) {
    const c = await find(handle);
    if (c.status !== "active") throw ApiError.notFound("Category");
    return dto(c, await productCounts());
  },
  async adminList() {
    const [rows, counts] = await Promise.all([prisma.category.findMany({ orderBy: { position: "asc" }, include: includeSubs }), productCounts()]);
    return rows.map((c) => dto(c, counts, true));
  },
  async create(name: string) {
    const max = await prisma.category.aggregate({ _max: { position: true } });
    const c = await prisma.category.create({ data: { name, handle: await uniqueHandle(name), position: (max._max.position ?? 0) + 1, status: "draft" }, include: includeSubs });
    return dto(c, await productCounts(), true);
  },
  async update(id: string, patch: { name?: string; handle?: string; description?: string | null; image?: string | null; icon?: string | null; featured?: boolean; status?: "active" | "hidden" | "draft"; concierge?: boolean; seoTitle?: string | null; seoDescription?: string | null }) {
    const c = await find(id);
    const { image, ...rest } = patch;
    const updated = await prisma.category.update({
      where: { id: c.id },
      data: { ...rest, imageUrl: image, handle: patch.handle ? await uniqueHandle(patch.handle, c.id) : undefined },
      include: includeSubs,
    });
    return { before: dto(c, await productCounts(), true), after: dto(updated, await productCounts(), true) };
  },
  async move(id: string, dir: "up" | "down") {
    const all = await prisma.category.findMany({ orderBy: { position: "asc" } });
    const i = all.findIndex((c) => c.id === id || c.handle === id);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0) throw ApiError.notFound("Category");
    if (j >= 0 && j < all.length) {
      [all[i], all[j]] = [all[j], all[i]];
      await prisma.$transaction(all.map((c, k) => prisma.category.update({ where: { id: c.id }, data: { position: k + 1 } })));
    }
    return this.adminList();
  },
  async remove(id: string) {
    const c = await find(id);
    const used = await prisma.product.count({ where: { categoryId: c.id, deletedAt: null } });
    if (used) throw ApiError.conflict("CONFLICT", `${used} product(s) are in this category. Move them first.`);
    await prisma.category.delete({ where: { id: c.id } });
    return c;
  },
  async addSub(id: string, name: string) {
    const c = await find(id);
    const handle = slugify(name);
    if (c.subcategories.some((s) => s.handle === handle)) throw ApiError.conflict("CONFLICT", "This subcategory already exists.");
    await prisma.subcategory.create({ data: { categoryId: c.id, name, handle, position: c.subcategories.length + 1 } });
    return dto(await find(c.id), await productCounts(), true);
  },
  async updateSub(id: string, subId: string, patch: { name?: string; status?: "active" | "hidden" | "draft"; image?: string | null }) {
    const c = await find(id);
    await prisma.subcategory.update({ where: { id: subId, categoryId: c.id }, data: { name: patch.name, status: patch.status, imageUrl: patch.image } });
    return dto(await find(c.id), await productCounts(), true);
  },
  async removeSub(id: string, subId: string) {
    const c = await find(id);
    const used = await prisma.product.count({ where: { subcategoryId: subId, deletedAt: null } });
    if (used) throw ApiError.conflict("CONFLICT", `${used} product(s) use this subcategory. Move them first.`);
    await prisma.subcategory.delete({ where: { id: subId, categoryId: c.id } });
    return dto(await find(c.id), await productCounts(), true);
  },
};

async function uniqueHandle(base: string, ignoreId?: string) {
  const root = slugify(base) || "category";
  for (let i = 0; ; i++) {
    const h = i ? `${root}-${i + 1}` : root;
    const hit = await prisma.category.findUnique({ where: { handle: h } });
    if (!hit || hit.id === ignoreId) return h;
  }
}
