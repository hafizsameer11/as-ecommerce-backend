import { prisma } from "@/core/db/prisma";
import { productInclude, toProductCard } from "../products/product.mapper";
import { storeWhere } from "../products/products.query";
import type { SearchQuery } from "./search.schemas";

const DEFAULT_POPULAR = ["New Arrivals", "Clothing", "Footwear", "Accessories", "Watches", "Fragrances", "Best Sellers", "Trending Now", "Sale", "Concierge"];

export const searchService = {
  async search(query: SearchQuery, who: { customerId?: string; anonId?: string }) {
    const where = await storeWhere({ q: query.q, sort: "featured", page: 1, pageSize: query.limit });
    const [products, total, brands, categories] = await Promise.all([
      prisma.product.findMany({ where, include: productInclude, orderBy: [{ bestSellerScore: "desc" }], take: query.limit }),
      prisma.product.count({ where }),
      prisma.brand.findMany({ where: { status: "active", name: { contains: query.q } }, take: 6, select: { handle: true, name: true } }),
      prisma.category.findMany({ where: { status: "active", name: { contains: query.q } }, take: 6, select: { handle: true, name: true } }),
    ]);
    await prisma.searchLog.create({ data: { query: query.q.toLowerCase().slice(0, 200), results: total, customerId: who.customerId, anonId: who.anonId } });
    return { query: query.q, total, products: products.map(toProductCard), brands, categories };
  },

  async suggest(q: string) {
    const [products, brands] = await Promise.all([
      prisma.product.findMany({ where: { status: "active", deletedAt: null, name: { contains: q } }, take: 6, select: { handle: true, name: true, brand: { select: { name: true } } } }),
      prisma.brand.findMany({ where: { status: "active", name: { startsWith: q } }, take: 4, select: { handle: true, name: true } }),
    ]);
    return { products: products.map((p) => ({ id: p.handle, name: p.name, brand: p.brand.name })), brands };
  },

  /** Popular searches from real search logs, falling back to a curated list. */
  async popular() {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await prisma.searchLog.groupBy({ by: ["query"], where: { createdAt: { gte: since }, results: { gt: 0 } }, _count: true, orderBy: { _count: { query: "desc" } }, take: 10 });
    const fromLogs = rows.filter((r) => r._count >= 3).map((r) => r.query.replace(/\b\w/g, (c) => c.toUpperCase()));
    return [...new Set([...fromLogs, ...DEFAULT_POPULAR])].slice(0, 10);
  },
};
