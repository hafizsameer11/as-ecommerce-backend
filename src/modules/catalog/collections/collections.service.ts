import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { slugify } from "@/core/utils/slug";
import { productInclude, toProductCard } from "../products/product.mapper";
import { smartWhere, type SmartRule } from "../products/products.query";

export type CollectionInput = Partial<{
  title: string; handle: string; description: string | null; status: "active" | "scheduled" | "draft" | "archived";
  type: "manual" | "smart"; slot: "hero" | "home_row_1" | "home_row_2" | "shop_hub" | "none"; rules: SmartRule[];
  productIds: string[]; coverUrl: string | null; featured: boolean; sortOrder: "manual" | "newest" | "price_asc" | "price_desc" | "bestseller";
  tags: string[]; scheduledFor: string | null;
}>;

const withProducts = { products: { orderBy: { position: "asc" as const }, select: { productId: true, position: true, product: { select: { handle: true } } } } };
type Row = Prisma.CollectionGetPayload<{ include: typeof withProducts }>;

function sortFor(s: Row["sortOrder"]): Prisma.ProductOrderByWithRelationInput[] {
  if (s === "newest") return [{ publishedAt: "desc" }];
  if (s === "price_asc") return [{ price: "asc" }];
  if (s === "price_desc") return [{ price: "desc" }];
  if (s === "bestseller") return [{ bestSellerScore: "desc" }];
  return [];
}

async function productsOf(c: Row, limit?: number) {
  const base: Prisma.ProductWhereInput = { status: "active", deletedAt: null };
  if (c.type === "smart") {
    const rows = await prisma.product.findMany({ where: { AND: [base, smartWhere((c.rules as SmartRule[]) ?? [])] }, include: productInclude, orderBy: sortFor(c.sortOrder), take: limit });
    return rows.map(toProductCard);
  }
  const ids = c.products.map((p) => p.productId);
  const rows = await prisma.product.findMany({ where: { AND: [base, { id: { in: ids } }] }, include: productInclude, orderBy: sortFor(c.sortOrder) });
  const ordered = c.sortOrder === "manual" ? ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as typeof rows : rows;
  return (limit ? ordered.slice(0, limit) : ordered).map(toProductCard);
}

const dto = (c: Row, admin = false) => ({
  id: c.id, handle: c.handle, title: c.title, description: c.description, cover: c.coverUrl, featured: c.featured, slot: c.slot,
  ...(admin ? {
    status: c.status, type: c.type, rules: c.rules ?? [], productIds: c.products.map((p) => p.product.handle), sortOrder: c.sortOrder,
    tags: c.tags ?? [], publishedAt: c.publishedAt, scheduledFor: c.scheduledFor, createdAt: c.createdAt, updatedAt: c.updatedAt,
  } : {}),
});

async function find(idOrHandle: string) {
  const c = await prisma.collection.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] }, include: withProducts });
  if (!c) throw ApiError.notFound("Collection");
  return c;
}

async function uniqueHandle(base: string, ignoreId?: string) {
  const root = slugify(base) || "collection";
  for (let i = 0; ; i++) {
    const h = i ? `${root}-${i + 1}` : root;
    const hit = await prisma.collection.findUnique({ where: { handle: h } });
    if (!hit || hit.id === ignoreId) return h;
  }
}

async function setProducts(collectionId: string, handlesOrIds: string[]) {
  const rows = await prisma.product.findMany({ where: { OR: [{ handle: { in: handlesOrIds } }, { id: { in: handlesOrIds } }] }, select: { id: true, handle: true } });
  const ordered = handlesOrIds.map((h) => rows.find((r) => r.handle === h || r.id === h)).filter(Boolean) as typeof rows;
  await prisma.$transaction([
    prisma.collectionProduct.deleteMany({ where: { collectionId } }),
    prisma.collectionProduct.createMany({ data: ordered.map((p, i) => ({ collectionId, productId: p.id, position: i })) }),
  ]);
}

export const collectionsService = {
  productsOf,
  async storeGet(handle: string) {
    const c = await find(handle);
    if (c.status !== "active") throw ApiError.notFound("Collection");
    return { ...dto(c), products: await productsOf(c) };
  },
  /** home rows / shop hub */
  async bySlot(slot: Row["slot"], productLimit = 12) {
    const rows = await prisma.collection.findMany({ where: { slot, status: "active" }, include: withProducts, orderBy: [{ featured: "desc" }, { updatedAt: "desc" }] });
    return Promise.all(rows.map(async (c) => ({ ...dto(c), products: await productsOf(c, productLimit) })));
  },
  async adminList(q: { q?: string; status?: Row["status"] }) {
    const rows = await prisma.collection.findMany({ where: { status: q.status, title: q.q ? { contains: q.q } : undefined }, include: withProducts, orderBy: { updatedAt: "desc" } });
    return Promise.all(rows.map(async (c) => ({ ...dto(c, true), productCount: c.type === "manual" ? c.products.length : (await productsOf(c)).length })));
  },
  async adminGet(id: string) {
    return dto(await find(id), true);
  },
  async preview(id: string) {
    return productsOf(await find(id));
  },
  async create(input: CollectionInput & { title: string }) {
    const c = await prisma.collection.create({
      data: {
        title: input.title, handle: await uniqueHandle(input.handle ?? input.title), description: input.description, status: input.status ?? "draft",
        type: input.type ?? "manual", slot: input.slot ?? "none", rules: input.rules ?? [], coverUrl: input.coverUrl, featured: input.featured ?? false,
        sortOrder: input.sortOrder ?? "manual", tags: input.tags ?? [], scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        publishedAt: input.status === "active" ? new Date() : null,
      },
    });
    if (input.productIds) await setProducts(c.id, input.productIds);
    return this.adminGet(c.id);
  },
  async update(id: string, patch: CollectionInput) {
    const before = await this.adminGet(id);
    await prisma.collection.update({
      where: { id: before.id },
      data: {
        title: patch.title, description: patch.description, status: patch.status, type: patch.type, slot: patch.slot, rules: patch.rules,
        coverUrl: patch.coverUrl, featured: patch.featured, sortOrder: patch.sortOrder, tags: patch.tags,
        handle: patch.handle ? await uniqueHandle(patch.handle, before.id) : undefined,
        scheduledFor: patch.scheduledFor === undefined ? undefined : patch.scheduledFor ? new Date(patch.scheduledFor) : null,
        publishedAt: patch.status === "active" && !before.publishedAt ? new Date() : undefined,
      },
    });
    if (patch.productIds) await setProducts(before.id, patch.productIds);
    return { before, after: await this.adminGet(before.id) };
  },
  async duplicate(id: string) {
    const c = await this.adminGet(id);
    return this.create({ ...c, title: `${c.title} (Copy)`, handle: undefined, status: "draft", featured: false, slot: "none", scheduledFor: null, rules: c.rules as SmartRule[], tags: c.tags as string[] });
  },
  async remove(id: string) {
    const c = await find(id);
    await prisma.collection.delete({ where: { id: c.id } });
  },
};
