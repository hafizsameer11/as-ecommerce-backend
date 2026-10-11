import { prisma } from "@/core/db/prisma";
import { productInclude, toProductCard } from "../products/product.mapper";
import { categoriesService } from "../categories/categories.service";
import { collectionsService } from "../collections/collections.service";

const live = (now = new Date()) => ({
  status: "live" as const,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
});

export const homeService = {
  /** Home screen in ONE request (fast first paint on web + app). */
  async home() {
    const base = { status: "active" as const, deletedAt: null };
    const [heroSlots, slots, categories, bestSellers, trending, newArrivals, heroCollections, row1, row2] = await Promise.all([
      prisma.slot.findMany({ where: { page: "home", type: "hero", ...live() }, orderBy: [{ pinned: "desc" }, { position: "asc" }] }),
      prisma.slot.findMany({ where: { page: "home", NOT: { type: "hero" }, ...live() }, orderBy: [{ pinned: "desc" }, { position: "asc" }] }),
      categoriesService.storeList(),
      prisma.product.findMany({ where: { ...base, bestSellerScore: { gt: 0 } }, include: productInclude, orderBy: { bestSellerScore: "desc" }, take: 8 }),
      prisma.product.findMany({ where: { ...base, trendingScore: { gt: 0 } }, include: productInclude, orderBy: { trendingScore: "desc" }, take: 10 }),
      prisma.product.findMany({ where: base, include: productInclude, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], take: 12 }),
      collectionsService.bySlot("hero", 8),
      collectionsService.bySlot("home_row_1", 10),
      collectionsService.bySlot("home_row_2", 10),
    ]);
    return {
      hero: heroSlots,
      slots,
      categories: categories.filter((c) => c.id !== "sale"),
      bestSellers: bestSellers.map(toProductCard),
      trending: trending.map(toProductCard),
      newArrivals: newArrivals.map(toProductCard),
      collections: { hero: heroCollections, row1, row2 },
    };
  },
};
