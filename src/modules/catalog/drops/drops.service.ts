import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { productInclude, toProductCard } from "../products/product.mapper";
import { dropAdminInclude, emptyStats, toAdminDrop, type DropStats } from "./drops.mapper";
import { reservationsService } from "./reservations.service";
import type { AdminDropsQuery, CreateDropBody, UpdateDropBody } from "./drops.schemas";

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
const byRef = (idOrHandle: string): Prisma.DropWhereInput => ({ OR: [{ id: idOrHandle }, { product: { handle: idOrHandle } }] });

/** per-drop reservation numbers for the admin table / KPIs */
async function statsFor(dropIds?: string[]) {
  const scope: Prisma.ReservationWhereInput = dropIds ? { dropId: { in: dropIds } } : {};
  const [all, paid] = await Promise.all([
    prisma.reservation.groupBy({ by: ["dropId", "status"], where: { ...scope, OR: [{ status: { not: "pending_deposit" } }, { holdExpiresAt: { gt: new Date() } }] }, _count: { _all: true }, _sum: { deposit: true } }),
    prisma.reservation.groupBy({ by: ["dropId", "status", "depositOutcome"], where: { ...scope, depositPaidAt: { not: null } }, _count: { _all: true }, _sum: { deposit: true, depositRefunded: true } }),
  ]);
  const out = new Map<string, DropStats>();
  const get = (id: string) => out.get(id) ?? out.set(id, emptyStats()).get(id)!;
  for (const g of all) {
    const s = get(g.dropId);
    const n = g._count._all;
    if (g.status === "pending_deposit") s.pending += n;
    if (g.status === "reserved") {
      s.reserved += n;
      s.depositsHeld += g._sum.deposit ?? 0;
    }
    if (g.status === "balance_paid") s.converted += n;
    if (g.status === "expired") s.expired += n;
    if (g.status === "cancelled") s.cancelled += n;
  }
  for (const g of paid) {
    const s = get(g.dropId);
    s.paidCount += g._count._all;
    s.depositsCollected += (g._sum.deposit ?? 0) - (g._sum.depositRefunded ?? 0);
    s.depositsRefunded += g._sum.depositRefunded ?? 0;
    if (g.depositOutcome === "forfeited") s.forfeited += g._sum.deposit ?? 0;
  }
  return out;
}

export const dropsService = {
  async list() {
    const rows = await prisma.drop.findMany({ where: { status: { in: ["upcoming", "live"] }, product: { deletedAt: null, status: { not: "archived" } } }, include: dropInclude, orderBy: { releaseAt: "asc" } });
    return rows.map(dto);
  },

  /** signed-in customers also get their reservation for this drop (drop page "Reserved") */
  async get(idOrHandle: string, customerId?: string) {
    const d = await prisma.drop.findFirst({ where: byRef(idOrHandle), include: dropInclude });
    if (!d) throw ApiError.notFound("Drop");
    return { ...dto(d), myReservation: customerId ? await reservationsService.activeFor(customerId, d.id) : null };
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

  // ── admin /drops ──
  async adminList(q: AdminDropsQuery) {
    const and: Prisma.DropWhereInput[] = [{ product: { deletedAt: null } }];
    if (q.tab !== "all") and.push({ status: q.tab });
    if (q.q) and.push({ OR: [{ product: { name: { contains: q.q } } }, { product: { handle: { contains: q.q } } }, { product: { brand: { name: { contains: q.q } } } }] });
    const where = { AND: and };
    const sort: Prisma.DropOrderByWithRelationInput = q.sort === "-releaseAt" ? { releaseAt: "desc" } : q.sort === "allocation" ? { allocation: "desc" } : { releaseAt: "asc" };
    const [rows, total, groups, totals, stats] = await Promise.all([
      prisma.drop.findMany({ where, include: dropAdminInclude, orderBy: sort, ...paging(q) }),
      prisma.drop.count({ where }),
      prisma.drop.groupBy({ by: ["status"], where: { product: { deletedAt: null } }, _count: { _all: true } }),
      prisma.drop.aggregate({ where: { product: { deletedAt: null } }, _sum: { allocation: true, reservedCount: true } }),
      statsFor(),
    ]);
    const c = (s?: string) => groups.filter((g) => !s || g.status === s).reduce((n, g) => n + g._count._all, 0);
    const sum = (k: keyof DropStats) => [...stats.values()].reduce((n, s) => n + s[k], 0);
    const paidCount = sum("paidCount");
    return withMeta(rows.map((d) => toAdminDrop(d, stats.get(d.id) ?? emptyStats())), {
      ...pageMeta(q, total),
      tabs: { all: c(), upcoming: c("upcoming"), live: c("live"), sold_out: c("sold_out"), ended: c("ended") },
      kpis: {
        drops: c(),
        upcoming: c("upcoming"),
        live: c("live") + c("sold_out"),
        allocation: totals._sum.allocation ?? 0,
        reserved: totals._sum.reservedCount ?? 0,
        pendingDeposits: sum("pending"),
        /** deposits kept (paid − refunded), incl. forfeited */
        depositsCollected: sum("depositsCollected"),
        /** liability today (2200): deposits of reservations still awaiting their balance */
        depositsHeld: sum("depositsHeld"),
        forfeited: sum("forfeited"),
        converted: sum("converted"),
        conversionPct: paidCount ? Math.round((sum("converted") / paidCount) * 1000) / 10 : 0,
      },
    });
  },

  async adminGet(idOrHandle: string) {
    const d = await prisma.drop.findFirst({ where: byRef(idOrHandle), include: dropAdminInclude });
    if (!d) throw ApiError.notFound("Drop");
    const stats = await statsFor([d.id]);
    return toAdminDrop(d, stats.get(d.id) ?? emptyStats());
  },

  async create(b: CreateDropBody) {
    const p = await prisma.product.findFirst({ where: { OR: [{ id: b.productId }, { handle: b.productId }], deletedAt: null } });
    if (!p) throw ApiError.notFound("Product");
    if (b.releaseAt <= new Date()) throw ApiError.badRequest("VALIDATION_FAILED", "The release date must be in the future.");
    if (await prisma.drop.findUnique({ where: { productId: p.id } })) throw ApiError.conflict("CONFLICT", "This product already has a drop. Edit it instead.");
    const s = await settingsService.get("drops");
    const d = await prisma.drop.create({
      data: { productId: p.id, releaseAt: b.releaseAt, allocation: b.allocation, depositPct: b.depositPct ?? s.depositPctDefault, teaser: b.teaser ?? null },
    });
    return this.adminGet(d.id);
  },

  /** deposit % applies to new reservations only (existing ones keep the price they agreed) */
  async update(idOrHandle: string, b: UpdateDropBody) {
    const before = await this.adminGet(idOrHandle);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Drop\` WHERE id = ${before.id} FOR UPDATE`;
      const d = await tx.drop.findUniqueOrThrow({ where: { id: before.id } });
      if (d.status === "ended") throw ApiError.conflict("INVALID_STATE", "This drop has ended.");
      if (b.releaseAt && d.status !== "upcoming") throw ApiError.conflict("INVALID_STATE", "The release date can't change after the drop is live.");
      if (b.releaseAt && b.releaseAt <= new Date()) throw ApiError.badRequest("VALIDATION_FAILED", "The release date must be in the future. Use \"Go live\" to release now.");
      if (b.allocation !== undefined) {
        const pending = await tx.reservation.count({ where: { dropId: d.id, status: "pending_deposit", holdExpiresAt: { gt: new Date() } } });
        if (b.allocation < d.reservedCount + pending)
          throw ApiError.badRequest("VALIDATION_FAILED", `The allocation can't be below the ${d.reservedCount + pending} places already taken.`);
      }
      await tx.drop.update({
        where: { id: d.id },
        data: { releaseAt: b.releaseAt, allocation: b.allocation, depositPct: b.depositPct, ...(b.teaser !== undefined ? { teaser: b.teaser } : {}) },
      });
    });
    return { before, after: await this.adminGet(before.id) };
  },

  async goLive(idOrHandle: string, actor: string) {
    const d = await this.adminGet(idOrHandle);
    const r = await reservationsService.markLive(d.id, actor);
    return { ...(await this.adminGet(d.id)), release: r };
  },

  /** close the drop: unpaid deposits and unpaid balances are cancelled, deposits refunded */
  async end(idOrHandle: string, actor: string) {
    const d = await this.adminGet(idOrHandle);
    if (d.status === "ended") throw ApiError.conflict("INVALID_STATE", "This drop has already ended.");
    const after = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM \`Drop\` WHERE id = ${d.id} FOR UPDATE`;
      const fns = await reservationsService.cancelOutstanding(tx, d.id, actor);
      await tx.drop.update({ where: { id: d.id }, data: { status: "ended" } });
      return fns;
    });
    for (const fn of after) await fn();
    return this.adminGet(d.id);
  },
};
