import type { Prisma } from "@/generated/prisma/client";

export const AVAILABILITY_LABEL = {
  in_stock: "In Stock",
  pre_order: "Pre Order",
  limited: "Limited Pieces",
  restocked: "Restocked",
} as const;

/** Everything a product card / product page needs, in one query. */
export const productInclude = {
  brand: { select: { name: true, handle: true } },
  category: { select: { name: true, handle: true } },
  subcategory: { select: { name: true, handle: true } },
  images: { orderBy: { position: "asc" } },
  colors: { orderBy: { position: "asc" } },
  sizeLabels: true,
  features: { orderBy: { position: "asc" } },
  variants: {
    where: { active: true },
    orderBy: { position: "asc" },
    include: { stock: { select: { onHand: true, reserved: true } } },
  },
  drop: { select: { id: true, releaseAt: true, status: true } },
} satisfies Prisma.ProductInclude;

export type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const available = (v: ProductRow["variants"][number]) => v.stock.reduce((n, s) => n + Math.max(0, s.onHand - s.reserved), 0);

/** Card shape (lists, carousels, wishlist, search). Matches the apps' `Product` type. */
export function toProductCard(p: ProductRow) {
  const sizes = [...new Set(p.variants.map((v) => v.size).filter(Boolean))] as string[];
  const sizeAvailability: Record<string, boolean> = {};
  for (const s of sizes) sizeAvailability[s] = p.variants.filter((v) => v.size === s).some((v) => available(v) > 0);
  const totalAvailable = p.variants.reduce((n, v) => n + available(v), 0);
  const onSale = !!p.compareAtPrice && p.compareAtPrice > p.price;
  return {
    id: p.handle,
    productId: p.id,
    brand: p.brand.name,
    brandHandle: p.brand.handle,
    name: p.name,
    price: p.price,
    originalPrice: onSale ? p.compareAtPrice : null,
    discountPct: onSale ? Math.round(((p.compareAtPrice! - p.price) / p.compareAtPrice!) * 100) : null,
    priceOnRequest: p.priceOnRequest,
    image: p.images[0]?.url ?? null,
    category: p.category.handle,
    categoryName: p.category.name,
    subcategory: p.subcategory?.name ?? null,
    subcategoryHandle: p.subcategory?.handle ?? null,
    sizes,
    sizeAvailability,
    colors: p.colors.map((c) => ({ name: c.name, hex: c.hex })),
    availability: AVAILABILITY_LABEL[p.availability],
    isConcierge: p.isConcierge,
    outOfStock: p.availability !== "pre_order" && totalAvailable === 0,
    rating: { average: p.ratingAvg, count: p.ratingCount },
    drop: p.drop && p.drop.status !== "ended" ? { id: p.drop.id, releaseAt: p.drop.releaseAt } : null,
  };
}

/** Full product page shape. */
export function toProductDetail(p: ProductRow) {
  const card = toProductCard(p);
  return {
    ...card,
    description: p.description,
    features: p.features.map((f) => f.text),
    styleCode: p.styleCode,
    gallery: p.images.map((i) => ({ url: i.url, alt: i.alt, color: i.color })),
    sizeLabels: Object.fromEntries(p.sizeLabels.map((l) => [l.size, l.label])),
    modelFit: p.modelFit,
    seo: { title: p.seoTitle ?? `${p.brand.name} ${p.name} - ASL ORIGINALS`, description: p.seoDescription ?? p.description?.slice(0, 160) ?? "" },
  };
}

/** Admin table + editor shape (includes cost, stock numbers, status). */
export function toAdminProduct(p: ProductRow) {
  const onHand = p.variants.reduce((n, v) => n + v.stock.reduce((m, s) => m + s.onHand, 0), 0);
  const reserved = p.variants.reduce((n, v) => n + v.stock.reduce((m, s) => m + s.reserved, 0), 0);
  const available = onHand - reserved;
  return {
    ...toProductDetail(p),
    status: p.status,
    availabilityKey: p.availability,
    compareAtPrice: p.compareAtPrice,
    cost: p.cost,
    featured: p.featured,
    useDesignerSizes: p.useDesignerSizes,
    stock: { onHand, reserved, available },
    stockState: p.availability === "pre_order" ? "Pre-order" : available <= 0 ? "Out of stock" : available <= 5 ? "Low stock" : "In stock",
    variants: p.variants.map((v) => ({ id: v.id, sku: v.sku, size: v.size, color: v.color, price: v.price, active: v.active, available: v.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) })),
    brandId: p.brandId,
    categoryId: p.categoryId,
    subcategoryId: p.subcategoryId,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    publishedAt: p.publishedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
