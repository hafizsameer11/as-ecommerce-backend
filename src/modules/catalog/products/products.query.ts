import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import type { StoreListQuery } from "./products.schemas";

/** Storefront list filters → Prisma where. Only active, non-deleted products. */
export async function storeWhere(q: StoreListQuery): Promise<Prisma.ProductWhereInput> {
  const and: Prisma.ProductWhereInput[] = [{ status: "active", deletedAt: null }];
  if (q.category === "sale") and.push({ compareAtPrice: { not: null } });
  else if (q.category) and.push({ category: { handle: q.category } });
  if (q.subcategory && !/^all[ -]/i.test(q.subcategory))
    and.push({ subcategory: { OR: [{ handle: q.subcategory }, { name: q.subcategory }] } });
  if (q.brand?.length) and.push({ brand: { OR: [{ handle: { in: q.brand } }, { name: { in: q.brand } }] } });
  if (q.size?.length) and.push({ variants: { some: { size: { in: q.size }, active: true } } });
  if (q.color?.length) and.push({ colors: { some: { name: { in: q.color } } } });
  if (q.availability?.length) and.push({ availability: { in: q.availability } });
  if (q.minPrice !== undefined || q.maxPrice !== undefined) and.push({ price: { gte: q.minPrice, lte: q.maxPrice } });
  if (q.onSale) and.push({ compareAtPrice: { not: null } });
  if (q.concierge !== undefined) and.push({ isConcierge: q.concierge });
  if (q.ids?.length) and.push({ handle: { in: q.ids } });
  if (q.inStock) and.push({ variants: { some: { stock: { some: { onHand: { gt: 0 } } } } } });
  if (q.collection) {
    const c = await prisma.collection.findUnique({ where: { handle: q.collection } });
    if (c?.type === "smart") and.push(smartWhere((c.rules as SmartRule[]) ?? []));
    else and.push({ collections: { some: { collection: { handle: q.collection } } } });
  }
  if (q.q) {
    const term = q.q.trim();
    and.push({
      OR: [
        { name: { contains: term } },
        { brand: { name: { contains: term } } },
        { category: { name: { contains: term } } },
        { subcategory: { name: { contains: term } } },
        { styleCode: { contains: term } },
        { variants: { some: { sku: term } } },
      ],
    });
  }
  return { AND: and };
}

export function storeOrderBy(sort: StoreListQuery["sort"]): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case "newest": return [{ publishedAt: "desc" }, { createdAt: "desc" }];
    case "price_asc": return [{ price: "asc" }];
    case "price_desc": return [{ price: "desc" }];
    case "best_selling": return [{ bestSellerScore: "desc" }, { createdAt: "desc" }];
    case "trending": return [{ trendingScore: "desc" }, { createdAt: "desc" }];
    case "rating": return [{ ratingAvg: "desc" }, { ratingCount: "desc" }];
    case "name": return [{ name: "asc" }];
    default: return [{ featured: "desc" }, { bestSellerScore: "desc" }, { createdAt: "asc" }];
  }
}

export type SmartRule = { field: "category" | "brand" | "price" | "availability" | "subcategory"; op: "is" | "is_not" | "gt" | "lt" | "contains"; value: string };

/** Smart collection rules → where (all rules must match). */
export function smartWhere(rules: SmartRule[]): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  for (const r of rules) {
    const v = r.value.trim();
    const neg = r.op === "is_not";
    let w: Prisma.ProductWhereInput | null = null;
    switch (r.field) {
      case "category": w = { category: r.op === "contains" ? { name: { contains: v } } : { OR: [{ handle: v }, { name: v }] } }; break;
      case "subcategory": w = { subcategory: r.op === "contains" ? { name: { contains: v } } : { OR: [{ handle: v }, { name: v }] } }; break;
      case "brand": w = { brand: r.op === "contains" ? { name: { contains: v } } : { OR: [{ handle: v }, { name: v }] } }; break;
      case "availability": {
        const key = AVAILABILITY_KEYS[v.toLowerCase()] ?? v;
        if (["in_stock", "pre_order", "limited", "restocked"].includes(key)) w = { availability: key as any };
        break;
      }
      case "price": {
        const n = Number(v);
        if (Number.isFinite(n)) w = r.op === "gt" ? { price: { gt: n } } : r.op === "lt" ? { price: { lt: n } } : { price: n };
        break;
      }
    }
    if (w) and.push(neg ? { NOT: w } : w);
  }
  return { AND: and };
}

/** smart rules may use the UI labels ("Restocked") or the enum keys */
const AVAILABILITY_KEYS: Record<string, string> = {
  "in stock": "in_stock", "pre order": "pre_order", "pre-order": "pre_order", "limited pieces": "limited", limited: "limited", restocked: "restocked",
};
