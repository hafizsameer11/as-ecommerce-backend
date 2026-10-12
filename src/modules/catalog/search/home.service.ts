import { prisma } from "@/core/db/prisma";
import { productInclude, toProductCard } from "../products/product.mapper";
import { categoriesService } from "../categories/categories.service";
import { collectionsService } from "../collections/collections.service";
import { slotsService } from "@/modules/marketing/slots/slots.service";

export const homeService = {
  /** Home screen in ONE request (fast first paint on web + app). */
  async home(customerId?: string) {
    const base = { status: "active" as const, deletedAt: null };
    const [pageSlots, categories, bestSellers, trending, newArrivals, heroCollections, row1, row2] = await Promise.all([
      // live home slots for this caller (audience), pinned first then position — see marketing/slots
      slotsService.forPage("home", customerId),
      categoriesService.storeList(),
      prisma.product.findMany({ where: { ...base, bestSellerScore: { gt: 0 } }, include: productInclude, orderBy: { bestSellerScore: "desc" }, take: 8 }),
      prisma.product.findMany({ where: { ...base, trendingScore: { gt: 0 } }, include: productInclude, orderBy: { trendingScore: "desc" }, take: 10 }),
      prisma.product.findMany({ where: base, include: productInclude, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], take: 12 }),
      collectionsService.bySlot("hero", 8),
      collectionsService.bySlot("home_row_1", 10),
      collectionsService.bySlot("home_row_2", 10),
    ]);
    return {
      hero: pageSlots.filter((s) => s.type === "hero"),
      /** every other home slot (promo banners, grids, carousels…) in display order */
      slots: pageSlots.filter((s) => s.type !== "hero"),
      categories: categories.filter((c) => c.id !== "sale"),
      bestSellers: bestSellers.map(toProductCard),
      trending: trending.map(toProductCard),
      newArrivals: newArrivals.map(toProductCard),
      collections: { hero: heroCollections, row1, row2 },
    };
  },
};
