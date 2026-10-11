import type { Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta } from "@/core/http/pagination";
import { slugify } from "@/core/utils/slug";
import { mediaService } from "@/modules/content/media/media.service";
import { productInclude, toAdminProduct, toProductCard, toProductDetail } from "./product.mapper";
import { storeOrderBy, storeWhere } from "./products.query";
import type { StoreListQuery } from "./products.schemas";
import type { z } from "zod";
import type { adminListQuery, bulkSchema, productInput, productPatch } from "./products.schemas";

type Input = z.infer<typeof productInput>;
type Patch = z.infer<typeof productPatch>;

const PRICE_BUCKETS = [
  { id: "0-100000", label: "Under ₦100,000", min: 0, max: 10_000_000 },
  { id: "100000-250000", label: "₦100,000 - ₦250,000", min: 10_000_000, max: 25_000_000 },
  { id: "250000-500000", label: "₦250,000 - ₦500,000", min: 25_000_000, max: 50_000_000 },
  { id: "500000+", label: "Over ₦500,000", min: 50_000_000, max: Number.MAX_SAFE_INTEGER },
];

async function uniqueHandle(base: string, ignoreId?: string) {
  const root = slugify(base) || "product";
  for (let i = 0; i < 50; i++) {
    const h = i ? `${root}-${i + 1}` : root;
    const hit = await prisma.product.findUnique({ where: { handle: h }, select: { id: true } });
    if (!hit || hit.id === ignoreId) return h;
  }
  return `${root}-${Date.now().toString(36)}`;
}

function sku(handle: string, size?: string | null, color?: string | null) {
  return [handle, size, color].filter(Boolean).join("-").toUpperCase().replace(/[^A-Z0-9-]+/g, "").slice(0, 120);
}

/** Variants = sizes × colours; keeps existing variants (and their stock) when sizes/colours are edited. */
async function syncVariants(tx: Tx, productId: string, handle: string, sizes: string[], colors: string[]) {
  const s = sizes.length ? sizes : [null];
  const c = colors.length > 1 ? colors : [null]; // single-colour products don't need colour variants
  const wanted = s.flatMap((size, i) => c.map((color, j) => ({ size, color, position: i * 100 + j })));
  const existing = await tx.productVariant.findMany({ where: { productId } });
  for (const w of wanted) {
    const hit = existing.find((e) => e.size === w.size && e.color === w.color);
    if (hit) await tx.productVariant.update({ where: { id: hit.id }, data: { active: true, position: w.position } });
    else await tx.productVariant.create({ data: { productId, size: w.size, color: w.color, position: w.position, sku: sku(handle, w.size, w.color) } });
  }
  // deactivate (not delete) variants that were removed – orders and stock history keep pointing at them
  for (const e of existing)
    if (!wanted.some((w) => w.size === e.size && w.color === e.color)) await tx.productVariant.update({ where: { id: e.id }, data: { active: false } });
}

async function writeRelations(tx: Tx, productId: string, handle: string, input: Patch, isCreate: boolean) {
  if (input.colors) {
    await tx.productColor.deleteMany({ where: { productId } });
    await tx.productColor.createMany({ data: input.colors.map((c, i) => ({ productId, name: c.name, hex: c.hex, position: i })) });
  }
  if (input.images) {
    await tx.productImage.deleteMany({ where: { productId } });
    await tx.productImage.createMany({ data: input.images.map((im, i) => ({ productId, url: im.url, alt: im.alt, color: im.color, position: i })) });
  }
  if (input.features) {
    await tx.productFeature.deleteMany({ where: { productId } });
    await tx.productFeature.createMany({ data: input.features.map((text, i) => ({ productId, text, position: i })) });
  }
  if (input.sizeLabels) {
    await tx.productSizeLabel.deleteMany({ where: { productId } });
    await tx.productSizeLabel.createMany({ data: Object.entries(input.sizeLabels).map(([size, label]) => ({ productId, size, label })) });
  }
  if (input.sizes || input.colors || isCreate) {
    const current = await tx.productVariant.findMany({ where: { productId, active: true } });
    const sizes = input.sizes ?? [...new Set(current.map((v) => v.size).filter(Boolean) as string[])];
    const colors = (input.colors ?? (await tx.productColor.findMany({ where: { productId } }))).map((c) => c.name);
    await syncVariants(tx, productId, handle, sizes, colors);
  }
}

const scalar = (i: Patch) => ({
  name: i.name,
  brandId: i.brandId,
  categoryId: i.categoryId,
  subcategoryId: i.subcategoryId,
  price: i.price,
  compareAtPrice: i.compareAtPrice,
  cost: i.cost,
  description: i.description,
  styleCode: i.styleCode,
  availability: i.availability,
  status: i.status,
  isConcierge: i.isConcierge,
  priceOnRequest: i.priceOnRequest,
  featured: i.featured,
  modelFit: i.modelFit,
  useDesignerSizes: i.useDesignerSizes,
  seoTitle: i.seoTitle,
  seoDescription: i.seoDescription,
});

async function findByIdOrHandle(idOrHandle: string, where: Prisma.ProductWhereInput = {}) {
  return prisma.product.findFirst({
    where: { AND: [where, { OR: [{ id: idOrHandle }, { handle: idOrHandle }] }] },
    include: productInclude,
  });
}

export const productsService = {
  include: productInclude,

  // ───────────── storefront ─────────────
  async list(q: StoreListQuery) {
    const where = await storeWhere(q);
    const [rows, total] = await Promise.all([
      prisma.product.findMany({ where, include: productInclude, orderBy: storeOrderBy(q.sort), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.product.count({ where }),
    ]);
    return { items: rows.map(toProductCard), meta: pageMeta(q, total) };
  },

  /** Filter-sheet counts (brand / size / colour / price / availability) for the current category & search */
  async facets(q: StoreListQuery) {
    const base = await storeWhere({ ...q, brand: undefined, size: undefined, color: undefined, minPrice: undefined, maxPrice: undefined, availability: undefined });
    const rows = await prisma.product.findMany({
      where: base,
      select: {
        price: true, availability: true, brand: { select: { name: true, handle: true } },
        colors: { select: { name: true, hex: true } }, variants: { where: { active: true }, select: { size: true } },
      },
    });
    const count = <K extends string>(keys: K[]) => {
      const m = new Map<K, number>();
      for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
      return m;
    };
    const brands = count(rows.map((r) => r.brand.handle));
    const brandNames = new Map(rows.map((r) => [r.brand.handle, r.brand.name]));
    const sizes = count(rows.flatMap((r) => [...new Set(r.variants.map((v) => v.size).filter(Boolean) as string[])]));
    const colors = count(rows.flatMap((r) => r.colors.map((c) => c.name)));
    const hex = new Map(rows.flatMap((r) => r.colors.map((c) => [c.name, c.hex] as const)));
    const avail = count(rows.map((r) => r.availability));
    return {
      total: rows.length,
      brands: [...brands].map(([handle, n]) => ({ handle, name: brandNames.get(handle), count: n })).sort((a, b) => a.name!.localeCompare(b.name!)),
      sizes: [...sizes].map(([size, n]) => ({ size, count: n })),
      colors: [...colors].map(([name, n]) => ({ name, hex: hex.get(name), count: n })),
      availability: [...avail].map(([k, n]) => ({ key: k, count: n })),
      priceRanges: PRICE_BUCKETS.map((b) => ({ ...b, max: b.max === Number.MAX_SAFE_INTEGER ? null : b.max, count: rows.filter((r) => r.price >= b.min && r.price < b.max).length })),
      priceMin: rows.length ? Math.min(...rows.map((r) => r.price)) : 0,
      priceMax: rows.length ? Math.max(...rows.map((r) => r.price)) : 0,
    };
  },

  async detail(idOrHandle: string) {
    const p = await findByIdOrHandle(idOrHandle, { status: "active", deletedAt: null });
    if (!p) throw ApiError.notFound("Product");
    return toProductDetail(p);
  },

  async related(idOrHandle: string, limit = 4) {
    const p = await prisma.product.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] } });
    if (!p) throw ApiError.notFound("Product");
    const rows = await prisma.product.findMany({
      where: { status: "active", deletedAt: null, categoryId: p.categoryId, NOT: { id: p.id } },
      include: productInclude,
      orderBy: [{ bestSellerScore: "desc" }],
      take: 24,
    });
    // same brand first, then same subcategory, then the rest
    const score = (r: (typeof rows)[number]) => (r.brandId === p.brandId ? 2 : 0) + (r.subcategoryId === p.subcategoryId ? 1 : 0);
    return rows.sort((a, b) => score(b) - score(a)).slice(0, limit).map(toProductCard);
  },

  /** "You may also like": popular items not in the given list */
  async alsoLike(exclude: string[], limit = 8) {
    const rows = await prisma.product.findMany({
      where: { status: "active", deletedAt: null, NOT: { OR: [{ handle: { in: exclude } }, { id: { in: exclude } }] } },
      include: productInclude,
      orderBy: [{ trendingScore: "desc" }, { bestSellerScore: "desc" }],
      take: limit,
    });
    return rows.map(toProductCard);
  },

  async byHandles(handles: string[]) {
    const rows = await prisma.product.findMany({ where: { OR: [{ handle: { in: handles } }, { id: { in: handles } }] }, include: productInclude });
    return rows.map(toProductCard);
  },

  // ───────────── admin ─────────────
  async adminList(q: z.infer<typeof adminListQuery>) {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: q.status,
      brand: q.brand ? { OR: [{ id: q.brand }, { handle: q.brand }] } : undefined,
      category: q.category ? { OR: [{ id: q.category }, { handle: q.category }] } : undefined,
      availability: q.stock === "preorder" ? "pre_order" : undefined,
      OR: q.q ? [{ name: { contains: q.q } }, { handle: q.q }, { styleCode: { contains: q.q } }, { brand: { name: { contains: q.q } } }, { variants: { some: { sku: q.q } } }] : undefined,
    };
    const desc = q.sort?.startsWith("-");
    const key = q.sort?.replace(/^-/, "");
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      key === "price" ? { price: desc ? "desc" : "asc" } : key === "rating" ? { ratingAvg: desc ? "desc" : "asc" } : key === "brand" ? { brand: { name: desc ? "desc" : "asc" } } : key === "name" ? { name: desc ? "desc" : "asc" } : { updatedAt: "desc" };
    const rows = await prisma.product.findMany({ where, include: productInclude, orderBy });
    let items = rows.map(toAdminProduct);
    if (q.stock && q.stock !== "preorder") {
      const want = { in: "In stock", low: "Low stock", out: "Out of stock" }[q.stock];
      items = items.filter((i) => i.stockState === want);
    }
    if (key === "stock") items.sort((a, b) => (desc ? b.stock.available - a.stock.available : a.stock.available - b.stock.available));
    const total = items.length;
    const counts = {
      all: await prisma.product.count({ where: { deletedAt: null } }),
      active: await prisma.product.count({ where: { deletedAt: null, status: "active" } }),
      draft: await prisma.product.count({ where: { deletedAt: null, status: "draft" } }),
      archived: await prisma.product.count({ where: { deletedAt: null, status: "archived" } }),
    };
    return { items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), meta: { ...pageMeta(q, total), counts } };
  },

  async adminGet(id: string) {
    const p = await findByIdOrHandle(id, { deletedAt: null });
    if (!p) throw ApiError.notFound("Product");
    return toAdminProduct(p);
  },

  async create(input: Input) {
    const handle = input.handle ? await uniqueHandle(input.handle) : await uniqueHandle(input.name);
    const id = await prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: { ...scalar(input), name: input.name, brandId: input.brandId, categoryId: input.categoryId, price: input.price, handle, publishedAt: input.status === "active" ? new Date() : null },
      });
      await writeRelations(tx, p.id, handle, input, true);
      await ensureStockRows(tx, p.id);
      return p.id;
    });
    await mediaService.syncUsage("product", id, input.images?.map((i) => i.url) ?? []);
    return this.adminGet(id);
  },

  async update(id: string, patch: Patch) {
    const before = await this.adminGet(id);
    const handle = patch.handle && patch.handle !== before.id ? await uniqueHandle(patch.handle, before.productId) : before.id;
    await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: before.productId },
        data: { ...scalar(patch), handle, publishedAt: patch.status === "active" && !before.publishedAt ? new Date() : undefined },
      });
      await writeRelations(tx, before.productId, handle, patch, false);
      await ensureStockRows(tx, before.productId);
    });
    if (patch.images) await mediaService.syncUsage("product", before.productId, patch.images.map((i) => i.url));
    return { before, after: await this.adminGet(before.productId) };
  },

  async setStatus(id: string, status: "active" | "draft" | "archived") {
    const p = await this.adminGet(id);
    await prisma.product.update({ where: { id: p.productId }, data: { status, publishedAt: status === "active" && !p.publishedAt ? new Date() : undefined } });
    return this.adminGet(p.productId);
  },

  async duplicate(id: string) {
    const p = await this.adminGet(id);
    return this.create({
      name: `${p.name} (Copy)`,
      brandId: p.brandId, categoryId: p.categoryId, subcategoryId: p.subcategoryId, price: p.price, compareAtPrice: p.compareAtPrice, cost: p.cost,
      description: p.description, features: p.features, styleCode: p.styleCode, availability: p.availabilityKey, status: "draft",
      isConcierge: p.isConcierge, priceOnRequest: p.priceOnRequest, featured: false, modelFit: p.modelFit, useDesignerSizes: p.useDesignerSizes,
      sizes: p.sizes, colors: p.colors, images: p.gallery.map((g) => ({ url: g.url, alt: g.alt ?? undefined, color: g.color ?? undefined })),
      sizeLabels: p.sizeLabels, seoTitle: null, seoDescription: null,
    });
  },

  async remove(id: string) {
    const p = await this.adminGet(id);
    // soft delete keeps order history intact
    await prisma.product.update({ where: { id: p.productId }, data: { deletedAt: new Date(), status: "archived", handle: `${p.id}--deleted-${Date.now().toString(36)}` } });
    await prisma.mediaUsage.deleteMany({ where: { entityType: "product", entityId: p.productId } });
    return p;
  },

  async bulk(b: z.infer<typeof bulkSchema>) {
    const ids = (await prisma.product.findMany({ where: { OR: [{ id: { in: b.ids } }, { handle: { in: b.ids } }], deletedAt: null }, select: { id: true } })).map((r) => r.id);
    switch (b.action) {
      case "publish":
        await prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: "active" } });
        await prisma.product.updateMany({ where: { id: { in: ids }, publishedAt: null }, data: { publishedAt: new Date() } });
        break;
      case "draft": await prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: "draft" } }); break;
      case "archive": await prisma.product.updateMany({ where: { id: { in: ids } }, data: { status: "archived" } }); break;
      case "feature": await prisma.product.updateMany({ where: { id: { in: ids } }, data: { featured: true } }); break;
      case "unfeature": await prisma.product.updateMany({ where: { id: { in: ids } }, data: { featured: false } }); break;
      case "setCategory":
        if (!b.categoryId) throw ApiError.badRequest("VALIDATION_FAILED", "categoryId is required");
        await prisma.product.updateMany({ where: { id: { in: ids } }, data: { categoryId: b.categoryId, subcategoryId: b.subcategoryId ?? null } });
        break;
      case "delete":
        for (const id of ids) await this.remove(id);
        break;
    }
    return { updated: ids.length };
  },
};

/** every active variant gets a stock row in the default warehouse so it shows in /inventory */
export async function ensureStockRows(tx: Tx, productId: string) {
  const wh = await tx.warehouse.findFirst({ where: { isDefault: true } });
  if (!wh) return;
  const variants = await tx.productVariant.findMany({ where: { productId }, select: { id: true } });
  await tx.stockLevel.createMany({ data: variants.map((v) => ({ variantId: v.id, warehouseId: wh.id })), skipDuplicates: true });
}
