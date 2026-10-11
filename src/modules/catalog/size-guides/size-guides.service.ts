import { prisma } from "@/core/db/prisma";
import type { SizeGuideBody, SizeGuideQuery } from "./size-guides.schemas";

export const sizeGuidesService = {
  /** Brand guide wins over category guide. */
  async forProduct(query: SizeGuideQuery) {
    const rows = await prisma.sizeGuide.findMany({
      where: { OR: [query.brand ? { scope: "brand", target: query.brand } : {}, query.category ? { scope: "category", target: query.category } : {}].filter((o) => Object.keys(o).length) as any },
    });
    return rows.sort((a) => (a.scope === "brand" ? -1 : 1));
  },

  list() {
    return prisma.sizeGuide.findMany({ orderBy: [{ scope: "asc" }, { target: "asc" }] });
  },

  save(body: SizeGuideBody) {
    return prisma.sizeGuide.upsert({ where: { scope_target: { scope: body.scope, target: body.target } }, create: body, update: body });
  },

  async remove(id: string) {
    await prisma.sizeGuide.delete({ where: { id } });
  },
};
