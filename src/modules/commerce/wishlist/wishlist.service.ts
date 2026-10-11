import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { productInclude, toProductCard } from "@/modules/catalog/products/product.mapper";

async function productId(idOrHandle: string) {
  const p = await prisma.product.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }], deletedAt: null }, select: { id: true } });
  if (!p) throw ApiError.notFound("Product");
  return p.id;
}

export const wishlistService = {
  /** /wishlist page and account "Saved items" */
  async list(customerId: string) {
    const rows = await prisma.wishlistItem.findMany({
      where: { customerId, product: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      include: { product: { include: productInclude } },
    });
    const items = rows.map((r) => ({ ...toProductCard(r.product), saved: { size: r.size, color: r.color, at: r.createdAt } }));
    return { items, count: items.length, onSaleCount: items.filter((i) => i.originalPrice).length };
  },

  async ids(customerId: string) {
    const rows = await prisma.wishlistItem.findMany({ where: { customerId }, select: { product: { select: { handle: true } } } });
    return rows.map((r) => r.product.handle);
  },

  /** heart button: adds if missing, removes if present */
  async toggle(customerId: string, input: { productId: string; size?: string | null; color?: string | null }) {
    const pid = await productId(input.productId);
    const key = { customerId_productId: { customerId, productId: pid } };
    const existing = await prisma.wishlistItem.findUnique({ where: key });
    if (existing) {
      await prisma.wishlistItem.delete({ where: key });
      return { saved: false };
    }
    await prisma.wishlistItem.create({ data: { customerId, productId: pid, size: input.size ?? null, color: input.color ?? null } });
    return { saved: true };
  },

  async remove(customerId: string, idOrHandle: string) {
    const pid = await productId(idOrHandle);
    await prisma.wishlistItem.deleteMany({ where: { customerId, productId: pid } });
    return { saved: false };
  },

  /** after sign-in: items hearted as a guest (kept on the device) are saved to the account */
  async merge(customerId: string, items: { productId: string; size?: string | null; color?: string | null }[]) {
    const products = await prisma.product.findMany({
      where: { OR: [{ id: { in: items.map((i) => i.productId) } }, { handle: { in: items.map((i) => i.productId) } }], deletedAt: null },
      select: { id: true, handle: true },
    });
    const byKey = new Map(products.flatMap((p) => [[p.id, p.id], [p.handle, p.id]] as const));
    await prisma.wishlistItem.createMany({
      data: items.filter((i) => byKey.has(i.productId)).map((i) => ({ customerId, productId: byKey.get(i.productId)!, size: i.size ?? null, color: i.color ?? null })),
      skipDuplicates: true,
    });
    return this.list(customerId);
  },
};
