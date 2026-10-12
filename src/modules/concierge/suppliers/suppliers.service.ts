/**
 * Sourcing partners (admin /concierge/suppliers). Requests link to a supplier (`ConciergeRequest.supplierId`);
 * totalOrders / totalSpend / lastOrderAt count up when a linked request is ordered, and the detail view adds
 * live stats from the linked requests. On-time / fulfilment rates and rating stay staff-entered for now.
 */
import type { Prisma, Supplier } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { toCsv } from "@/core/utils/csv";
import { OPEN_STATUSES } from "../concierge.common";
import type { SupplierBody, SupplierPatch, SuppliersQuery } from "./suppliers.schemas";

const toSupplier = (s: Supplier) => ({
  id: s.id, name: s.name, contact: s.contact, email: s.email, phone: s.phone, country: s.country, city: s.city,
  categories: s.categories as string[], brands: s.brands as string[], tier: s.tier, status: s.status,
  leadTimeDays: s.leadTimeDays, onTimeRate: s.onTimeRate, fulfillmentRate: s.fulfillmentRate,
  totalOrders: s.totalOrders, totalSpend: Number(s.totalSpend), rating: s.rating, paymentTerms: s.paymentTerms,
  currency: s.currency, vip: s.vip, notes: s.notes ?? "", createdAt: s.createdAt, lastOrderAt: s.lastOrderAt, updatedAt: s.updatedAt,
});

function where(q: Omit<SuppliersQuery, "page" | "pageSize" | "sort" | "tab">): Prisma.SupplierWhereInput {
  return {
    ...(q.tier ? { tier: q.tier } : {}),
    ...(q.country ? { country: q.country } : {}),
    ...(q.vip !== undefined ? { vip: q.vip } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { contact: { contains: q.q } }, { email: { contains: q.q } }, { city: { contains: q.q } }, { country: { contains: q.q } }] } : {}),
  };
}

async function find(id: string) {
  const s = await prisma.supplier.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound("Supplier");
  return s;
}

export const suppliersService = {
  async list(q: SuppliersQuery) {
    const base = where(q);
    const w: Prisma.SupplierWhereInput = { ...base, ...(q.tab !== "all" ? { status: q.tab } : {}) };
    const [rows, total, groups, all, countries] = await Promise.all([
      prisma.supplier.findMany({ where: w, orderBy: [{ vip: "desc" }, { tier: "asc" }, { name: "asc" }], ...paging(q) }),
      prisma.supplier.count({ where: w }),
      prisma.supplier.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      prisma.supplier.findMany({ select: { status: true, vip: true, onTimeRate: true, totalOrders: true, totalSpend: true } }),
      prisma.supplier.findMany({ distinct: ["country"], select: { country: true }, orderBy: { country: "asc" } }),
    ]);
    const active = all.filter((s) => s.status === "active");
    const tabs = { all: groups.reduce((n, g) => n + g._count._all, 0), ...Object.fromEntries(groups.map((g) => [g.status, g._count._all])) };
    const kpis = {
      total: all.length,
      active: active.length,
      vip: all.filter((s) => s.vip).length,
      avgOnTime: active.length ? Math.round(active.reduce((n, s) => n + s.onTimeRate, 0) / active.length) : 0,
      orders: all.reduce((n, s) => n + s.totalOrders, 0),
      spend: all.reduce((n, s) => n + Number(s.totalSpend), 0),
    };
    return withMeta(rows.map(toSupplier), { ...pageMeta(q, total), tabs, kpis, countries: countries.map((c) => c.country) });
  },

  async exportCsv(q: SuppliersQuery) {
    const rows = await prisma.supplier.findMany({ where: { ...where(q), ...(q.tab !== "all" ? { status: q.tab } : {}) }, orderBy: { name: "asc" } });
    return toCsv(
      rows.map((s) => ({ ...toSupplier(s), categories: (s.categories as string[]).join("; "), brands: (s.brands as string[]).join("; "), totalSpend: Number(s.totalSpend) / 100 })),
      ["id", "name", "tier", "status", "contact", "email", "phone", "country", "city", "categories", "brands", "leadTimeDays", "onTimeRate", "fulfillmentRate", "totalOrders", "totalSpend", "rating", "paymentTerms", "currency", "vip"],
    );
  },

  async get(id: string) {
    const s = await find(id);
    const [byStatus, recent, paid] = await Promise.all([
      prisma.conciergeRequest.groupBy({ by: ["status"], where: { supplierId: id }, _count: { _all: true } }),
      prisma.conciergeRequest.findMany({ where: { supplierId: id }, orderBy: { updatedAt: "desc" }, take: 10, select: { id: true, number: true, itemName: true, brand: true, status: true, updatedAt: true } }),
      prisma.conciergeQuote.aggregate({ where: { status: "paid", request: { supplierId: id } }, _sum: { itemsTotal: true }, _count: { _all: true } }),
    ]);
    const n = (f: (s: string) => boolean) => byStatus.filter((g) => f(g.status)).reduce((x, g) => x + g._count._all, 0);
    return {
      ...toSupplier(s),
      stats: {
        requests: n(() => true),
        open: n((st) => (OPEN_STATUSES as string[]).includes(st)),
        delivered: n((st) => st === "delivered"),
        unavailable: n((st) => st === "unavailable"),
        paidOrders: paid._count._all,
        /** Σ item cost on paid quotes linked to this supplier, kobo */
        itemsValue: paid._sum.itemsTotal ?? 0,
      },
      recentRequests: recent,
    };
  },

  async create(b: SupplierBody) {
    const s = await prisma.supplier.create({ data: { ...b, notes: b.notes ?? null } });
    return toSupplier(s);
  },

  async update(id: string, b: SupplierPatch) {
    await find(id);
    return toSupplier(await prisma.supplier.update({ where: { id }, data: b }));
  },

  async toggleVip(id: string) {
    const s = await find(id);
    return toSupplier(await prisma.supplier.update({ where: { id }, data: { vip: !s.vip } }));
  },

  /** refused while open requests use the supplier; closed requests are unlinked */
  async remove(id: string) {
    const s = await find(id);
    const open = await prisma.conciergeRequest.count({ where: { supplierId: id, status: { in: OPEN_STATUSES } } });
    if (open) throw ApiError.conflict("CONFLICT", `${s.name} is linked to ${open} open request(s). Re-assign them or pause the supplier instead.`);
    await prisma.$transaction([
      prisma.conciergeRequest.updateMany({ where: { supplierId: id }, data: { supplierId: null } }),
      prisma.supplier.delete({ where: { id } }),
    ]);
    return { id, name: s.name };
  },
};
