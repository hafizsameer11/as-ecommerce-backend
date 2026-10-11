import type { Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { pageMeta } from "@/core/http/pagination";

type Line = { variantId: string; qty: number };

async function lockLevels(tx: Tx, variantIds: string[]) {
  if (!variantIds.length) return [];
  // row locks so two checkouts can't sell the same last unit
  return tx.$queryRaw<{ variantId: string; warehouseId: string; onHand: number; reserved: number; isDefault: number }[]>`
    SELECT s.variantId, s.warehouseId, s.onHand, s.reserved, w.isDefault
    FROM StockLevel s JOIN Warehouse w ON w.id = s.warehouseId
    WHERE s.variantId IN (${PrismaJoin(variantIds)}) AND w.active = 1
    ORDER BY w.isDefault DESC, (s.onHand - s.reserved) DESC
    FOR UPDATE`;
}

// Prisma.join without importing the runtime namespace in every caller
import { Prisma as P } from "@/generated/prisma/client";
const PrismaJoin = (ids: string[]) => P.join(ids);

async function move(tx: Tx, m: { variantId: string; warehouseId: string; type: Prisma.StockMovementCreateInput["type"]; qty: number; note?: string; refType?: string; refId?: string; actor?: string }) {
  const v = await tx.productVariant.findUniqueOrThrow({ where: { id: m.variantId }, select: { sku: true } });
  await tx.stockMovement.create({ data: { ...m, sku: v.sku } });
}

async function checkLow(variantId: string) {
  const levels = await prisma.stockLevel.findMany({ where: { variantId }, include: { variant: { select: { sku: true } } } });
  const available = levels.reduce((n, l) => n + l.onHand - l.reserved, 0);
  const reorder = Math.max(...levels.map((l) => l.reorderPoint), 0);
  if (levels.length && available <= reorder) events.emit("stock.low", { variantId, sku: levels[0].variant.sku, available });
}

export const inventoryService = {
  /** Reserve stock for an order (inside the order transaction). Throws OUT_OF_STOCK with the failing lines. */
  async reserve(tx: Tx, lines: Line[], ref: { type: string; id: string }) {
    const levels = await lockLevels(tx, [...new Set(lines.map((l) => l.variantId))]);
    const short: { variantId: string; requested: number; available: number }[] = [];
    const plan: { variantId: string; warehouseId: string; qty: number }[] = [];
    for (const line of lines) {
      let need = line.qty;
      const mine = levels.filter((l) => l.variantId === line.variantId);
      for (const l of mine) {
        const free = l.onHand - l.reserved;
        if (free <= 0 || need <= 0) continue;
        const take = Math.min(free, need);
        plan.push({ variantId: line.variantId, warehouseId: l.warehouseId, qty: take });
        l.reserved += take;
        need -= take;
      }
      if (need > 0) short.push({ variantId: line.variantId, requested: line.qty, available: line.qty - need });
    }
    if (short.length) throw ApiError.conflict("OUT_OF_STOCK", "Some items are out of stock. Remove or change them before checkout.", short);
    for (const p of plan) {
      await tx.stockLevel.update({ where: { variantId_warehouseId: { variantId: p.variantId, warehouseId: p.warehouseId } }, data: { reserved: { increment: p.qty } } });
      await move(tx, { ...p, type: "reserve", qty: 0, note: `Reserved ${p.qty}`, refType: ref.type, refId: ref.id });
    }
    return plan;
  },

  /** Release a reservation (order cancelled / unpaid) */
  async release(tx: Tx, ref: { type: string; id: string }) {
    const res = await tx.stockMovement.findMany({ where: { refType: ref.type, refId: ref.id, type: "reserve" } });
    const done = await tx.stockMovement.count({ where: { refType: ref.type, refId: ref.id, type: { in: ["release", "sale"] } } });
    if (done) return;
    for (const r of res) {
      const qty = Number(/Reserved (\d+)/.exec(r.note ?? "")?.[1] ?? 0);
      if (!qty) continue;
      await tx.stockLevel.update({ where: { variantId_warehouseId: { variantId: r.variantId, warehouseId: r.warehouseId } }, data: { reserved: { decrement: qty } } });
      await move(tx, { variantId: r.variantId, warehouseId: r.warehouseId, type: "release", qty: 0, note: `Released ${qty}`, refType: ref.type, refId: ref.id });
    }
  },

  /** Paid → reserved units leave the shelf */
  async commitSale(tx: Tx, ref: { type: string; id: string }) {
    const res = await tx.stockMovement.findMany({ where: { refType: ref.type, refId: ref.id, type: "reserve" } });
    if (await tx.stockMovement.count({ where: { refType: ref.type, refId: ref.id, type: "sale" } })) return;
    for (const r of res) {
      const qty = Number(/Reserved (\d+)/.exec(r.note ?? "")?.[1] ?? 0);
      if (!qty) continue;
      await tx.stockLevel.update({ where: { variantId_warehouseId: { variantId: r.variantId, warehouseId: r.warehouseId } }, data: { reserved: { decrement: qty }, onHand: { decrement: qty } } });
      await move(tx, { variantId: r.variantId, warehouseId: r.warehouseId, type: "sale", qty: -qty, refType: ref.type, refId: ref.id });
    }
    for (const id of new Set(res.map((r) => r.variantId))) void checkLow(id);
  },

  /** Approved return received back into stock */
  async restock(tx: Tx, variantId: string, qty: number, ref: { type: string; id: string }, actor?: string) {
    const wh = await tx.warehouse.findFirstOrThrow({ where: { isDefault: true } });
    await tx.stockLevel.upsert({
      where: { variantId_warehouseId: { variantId, warehouseId: wh.id } },
      create: { variantId, warehouseId: wh.id, onHand: qty },
      update: { onHand: { increment: qty } },
    });
    await move(tx, { variantId, warehouseId: wh.id, type: "return", qty, refType: ref.type, refId: ref.id, actor });
  },

  // ── admin /inventory ──
  async list(q: { page: number; pageSize: number; q?: string; warehouse?: string; state?: "in" | "low" | "out" }) {
    const where: Prisma.StockLevelWhereInput = {
      warehouseId: q.warehouse,
      variant: { active: true, product: { deletedAt: null } },
      OR: q.q ? [{ variant: { sku: { contains: q.q } } }, { variant: { product: { name: { contains: q.q } } } }] : undefined,
    };
    const rows = await prisma.stockLevel.findMany({
      where,
      include: { warehouse: true, variant: { include: { product: { select: { handle: true, name: true, brand: { select: { name: true } }, images: { take: 1, orderBy: { position: "asc" } }, availability: true } } } } },
      orderBy: [{ variant: { product: { name: "asc" } } }, { variant: { position: "asc" } }],
    });
    let items = rows.map((r) => {
      const available = r.onHand - r.reserved;
      const state = r.variant.product.availability === "pre_order" && available <= 0 ? "Backorder" : available <= 0 ? "Out of stock" : available <= r.reorderPoint ? "Low stock" : "In stock";
      return {
        sku: r.variant.sku, variantId: r.variantId, productId: r.variant.product.handle, productName: r.variant.product.name, brand: r.variant.product.brand.name,
        image: r.variant.product.images[0]?.url ?? null, variant: [r.variant.size, r.variant.color].filter(Boolean).join(" / ") || "One size",
        warehouseId: r.warehouseId, warehouse: r.warehouse.name, warehouseCode: r.warehouse.code,
        onHand: r.onHand, reserved: r.reserved, available, reorderPoint: r.reorderPoint, cost: r.cost, state, updatedAt: r.updatedAt,
      };
    });
    const summary = {
      skus: items.length,
      units: items.reduce((n, i) => n + i.onHand, 0),
      value: items.reduce((n, i) => n + i.onHand * (i.cost ?? 0), 0),
      low: items.filter((i) => i.state === "Low stock").length,
      out: items.filter((i) => i.state === "Out of stock").length,
    };
    if (q.state) items = items.filter((i) => i.state === { in: "In stock", low: "Low stock", out: "Out of stock" }[q.state!]);
    return { items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), meta: { ...pageMeta(q, items.length), summary } };
  },

  async adjust(input: { sku: string; warehouseId: string; delta: number; note: string; type?: "adjust" | "receive" }, actor: string) {
    const v = await prisma.productVariant.findUnique({ where: { sku: input.sku } });
    if (!v) throw ApiError.notFound("SKU");
    const before = await prisma.stockLevel.findUnique({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: input.warehouseId } } });
    if ((before?.onHand ?? 0) + input.delta < (before?.reserved ?? 0))
      throw ApiError.badRequest("INVALID_STATE", "On-hand can't go below the units already reserved for orders.");
    await prisma.$transaction(async (tx) => {
      await tx.stockLevel.upsert({
        where: { variantId_warehouseId: { variantId: v.id, warehouseId: input.warehouseId } },
        create: { variantId: v.id, warehouseId: input.warehouseId, onHand: Math.max(0, input.delta) },
        update: { onHand: { increment: input.delta } },
      });
      await move(tx, { variantId: v.id, warehouseId: input.warehouseId, type: input.type ?? "adjust", qty: input.delta, note: input.note, actor });
    });
    // back-in-stock alerts when a sold-out variant gets units again
    if (input.delta > 0 && (before?.onHand ?? 0) - (before?.reserved ?? 0) <= 0) await notifyBackInStock(v.productId, v.size);
    void checkLow(v.id);
    return prisma.stockLevel.findUnique({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: input.warehouseId } } });
  },

  async transfer(input: { sku: string; from: string; to: string; qty: number; note: string }, actor: string) {
    if (input.from === input.to) throw ApiError.badRequest("VALIDATION_FAILED", "Choose two different warehouses.");
    const v = await prisma.productVariant.findUnique({ where: { sku: input.sku } });
    if (!v) throw ApiError.notFound("SKU");
    await prisma.$transaction(async (tx) => {
      const [src] = await tx.$queryRaw<{ onHand: number; reserved: number }[]>`SELECT onHand, reserved FROM StockLevel WHERE variantId = ${v.id} AND warehouseId = ${input.from} FOR UPDATE`;
      if (!src || src.onHand - src.reserved < input.qty) throw ApiError.badRequest("OUT_OF_STOCK", "Not enough free stock in the source warehouse.");
      await tx.stockLevel.update({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: input.from } }, data: { onHand: { decrement: input.qty } } });
      await tx.stockLevel.upsert({
        where: { variantId_warehouseId: { variantId: v.id, warehouseId: input.to } },
        create: { variantId: v.id, warehouseId: input.to, onHand: input.qty },
        update: { onHand: { increment: input.qty } },
      });
      await move(tx, { variantId: v.id, warehouseId: input.from, type: "transfer_out", qty: -input.qty, note: input.note, actor });
      await move(tx, { variantId: v.id, warehouseId: input.to, type: "transfer_in", qty: input.qty, note: input.note, actor });
    });
    return { transferred: input.qty };
  },

  async setReorderPoint(sku: string, warehouseId: string, reorderPoint: number) {
    const v = await prisma.productVariant.findUnique({ where: { sku } });
    if (!v) throw ApiError.notFound("SKU");
    return prisma.stockLevel.update({ where: { variantId_warehouseId: { variantId: v.id, warehouseId } }, data: { reorderPoint } });
  },

  async movements(q: { page: number; pageSize: number; sku?: string; type?: string }) {
    const where: Prisma.StockMovementWhereInput = { sku: q.sku, type: q.type as any, NOT: { type: { in: ["reserve", "release"] } } };
    const [rows, total] = await Promise.all([
      prisma.stockMovement.findMany({ where, include: { warehouse: { select: { name: true, code: true } } }, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.stockMovement.count({ where }),
    ]);
    return { items: rows, meta: pageMeta(q, total) };
  },
};

async function notifyBackInStock(productId: string, size: string | null) {
  const alerts = await prisma.backInStockAlert.findMany({
    where: { productId, notifiedAt: null, size: { in: ["", size ?? ""] } },
    include: { product: { select: { name: true, handle: true } } },
  });
  for (const a of alerts) {
    await prisma.notification.create({
      data: {
        customerId: a.customerId, category: "Wishlist", title: "Back in Stock", icon: "ShoppingBag",
        message: `${a.product.name}${a.size ? ` (size ${a.size})` : ""} is back in stock.`, ctaLabel: "View Item", ctaHref: `/product/${a.product.handle}`,
      },
    });
    await prisma.backInStockAlert.update({ where: { id: a.id }, data: { notifiedAt: new Date() } });
  }
}
