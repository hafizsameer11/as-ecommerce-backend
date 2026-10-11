import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { productInclude, toProductCard } from "../products/product.mapper";
import { storeWhere } from "../products/products.query";

const DEFAULT_POPULAR = ["New Arrivals", "Clothing", "Footwear", "Accessories", "Watches", "Fragrances", "Best Sellers", "Trending Now", "Sale", "Concierge"];

/** /search screen */
export const searchStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/search", tag: "Search", defaultAuth: "optionalCustomer" })
  .get("/", {
    summary: "Search products, brands and categories",
    query: z.object({ q: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(1).max(60).default(24) }),
  }, async ({ query, req }) => {
    const where = await storeWhere({ q: query.q, sort: "featured", page: 1, pageSize: query.limit });
    const [products, total, brands, categories] = await Promise.all([
      prisma.product.findMany({ where, include: productInclude, orderBy: [{ bestSellerScore: "desc" }], take: query.limit }),
      prisma.product.count({ where }),
      prisma.brand.findMany({ where: { status: "active", name: { contains: query.q } }, take: 6, select: { handle: true, name: true } }),
      prisma.category.findMany({ where: { status: "active", name: { contains: query.q } }, take: 6, select: { handle: true, name: true } }),
    ]);
    await prisma.searchLog.create({ data: { query: query.q.toLowerCase().slice(0, 200), results: total, customerId: req.customer?.id, anonId: req.anonId } });
    return { query: query.q, total, products: products.map(toProductCard), brands, categories };
  })
  .get("/suggest", { summary: "Type-ahead suggestions", query: z.object({ q: z.string().trim().min(1).max(60) }) }, async ({ query }) => {
    const [products, brands] = await Promise.all([
      prisma.product.findMany({ where: { status: "active", deletedAt: null, name: { contains: query.q } }, take: 6, select: { handle: true, name: true, brand: { select: { name: true } } } }),
      prisma.brand.findMany({ where: { status: "active", name: { startsWith: query.q } }, take: 4, select: { handle: true, name: true } }),
    ]);
    return { products: products.map((p) => ({ id: p.handle, name: p.name, brand: p.brand.name })), brands };
  })
  .get("/popular", { summary: "Popular searches (from real search logs, falls back to curated list)" }, async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await prisma.searchLog.groupBy({ by: ["query"], where: { createdAt: { gte: since }, results: { gt: 0 } }, _count: true, orderBy: { _count: { query: "desc" } }, take: 10 });
    const fromLogs = rows.filter((r) => r._count >= 3).map((r) => r.query.replace(/\b\w/g, (c) => c.toUpperCase()));
    return [...new Set([...fromLogs, ...DEFAULT_POPULAR])].slice(0, 10);
  });
