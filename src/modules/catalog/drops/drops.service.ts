import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { productInclude, toProductCard } from "../products/product.mapper";

const dropInclude = { product: { include: productInclude } } as const;

function dto(d: Awaited<ReturnType<typeof prisma.drop.findFirstOrThrow<{ include: typeof dropInclude }>>>) {
  const deposit = Math.round((d.product.price * d.depositPct) / 100);
  return {
    id: d.id, product: toProductCard(d.product), releaseAt: d.releaseAt, allocation: d.allocation, reservedCount: d.reservedCount,
    remaining: Math.max(0, d.allocation - d.reservedCount), teaser: d.teaser, status: d.status, depositPct: d.depositPct,
    deposit, balance: d.product.price - deposit,
  };
}

const findProduct = (idOrHandle: string) => prisma.product.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] } });

export const dropsService = {
  async list() {
    const rows = await prisma.drop.findMany({ where: { status: { in: ["upcoming", "live"] }, product: { deletedAt: null, status: { not: "archived" } } }, include: dropInclude, orderBy: { releaseAt: "asc" } });
    return rows.map(dto);
  },

  async get(idOrHandle: string) {
    const d = await prisma.drop.findFirst({ where: { OR: [{ id: idOrHandle }, { product: { handle: idOrHandle } }] }, include: dropInclude });
    if (!d) throw ApiError.notFound("Drop");
    return dto(d);
  },

  /** "Notify me" when a sold-out product / size is back */
  async subscribeStockAlert(customerId: string, productIdOrHandle: string, size?: string) {
    const p = await findProduct(productIdOrHandle);
    if (!p) throw ApiError.notFound("Product");
    await prisma.backInStockAlert.upsert({
      where: { productId_customerId_size: { productId: p.id, customerId, size: size ?? "" } },
      create: { productId: p.id, customerId, size: size ?? "" },
      update: { notifiedAt: null },
    });
    return { subscribed: true };
  },

  async unsubscribeStockAlert(customerId: string, productIdOrHandle: string, size?: string) {
    const p = await findProduct(productIdOrHandle);
    if (p) await prisma.backInStockAlert.deleteMany({ where: { productId: p.id, customerId, size: size ?? undefined } });
    return { subscribed: false };
  },
};
