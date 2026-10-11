import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
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

/** /coming-soon and /drop/:id (reserving needs payments → commerce phase) */
export const dropsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/drops", tag: "Drops" })
  .get("/", { summary: "Upcoming & live drops" }, async () => {
    const rows = await prisma.drop.findMany({ where: { status: { in: ["upcoming", "live"] }, product: { deletedAt: null, status: { not: "archived" } } }, include: dropInclude, orderBy: { releaseAt: "asc" } });
    return rows.map(dto);
  })
  .get("/:id", { summary: "One drop", params: idParam }, async ({ params }) => {
    const d = await prisma.drop.findFirst({ where: { OR: [{ id: params.id }, { product: { handle: params.id } }] }, include: dropInclude });
    if (!d) throw ApiError.notFound("Drop");
    return dto(d);
  });

/** "Notify me" when a sold-out product / size is back */
export const stockAlertsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/products/:id/notify-me", tag: "Products", defaultAuth: "customer" })
  .post("/", { summary: "Notify me when back in stock", params: idParam, body: z.object({ size: z.string().max(20).optional() }) }, async ({ customerId, params, body }) => {
    const p = await prisma.product.findFirst({ where: { OR: [{ id: params.id }, { handle: params.id }] } });
    if (!p) throw ApiError.notFound("Product");
    await prisma.backInStockAlert.upsert({
      where: { productId_customerId_size: { productId: p.id, customerId, size: body.size ?? "" } },
      create: { productId: p.id, customerId, size: body.size ?? "" },
      update: { notifiedAt: null },
    });
    return { subscribed: true };
  })
  .delete("/", { summary: "Stop notifying", params: idParam, query: z.object({ size: z.string().optional() }) }, async ({ customerId, params, query }) => {
    const p = await prisma.product.findFirst({ where: { OR: [{ id: params.id }, { handle: params.id }] } });
    if (p) await prisma.backInStockAlert.deleteMany({ where: { productId: p.id, customerId, size: query.size ?? undefined } });
    return { subscribed: false };
  });
