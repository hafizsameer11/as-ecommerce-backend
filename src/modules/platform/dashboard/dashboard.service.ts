/**
 * asl-admin "/" dashboard. Sales, product and traffic numbers come from the daily rollups
 * (today computed live); "recent" lists, statuses, concierge pipeline and low stock read the live tables.
 */
import { prisma } from "@/core/db/prisma";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { delta, periodOf, ratio } from "@/modules/platform/analytics/analytics.dates";
import { groupSum, productFacts, salesFacts, sum, trafficFacts } from "@/modules/platform/analytics/analytics.facts";
import { productInfo } from "@/modules/platform/analytics/analytics.service";
import type { DashboardQuery } from "./dashboard.schemas";

const kpi = (value: number, previous: number) => ({ value, previous, delta: delta(value, previous) });

export const dashboardService = {
  async get(q: DashboardQuery) {
    const p = periodOf(q.range);
    const cur = { from: p.from, to: p.to };
    const prev = { from: p.prevFrom, to: p.prevTo };
    const [sales, prevSales, traffic, prevTraffic, stats, newCustomers, prevNewCustomers] = await Promise.all([
      salesFacts(cur), salesFacts(prev), trafficFacts(cur), trafficFacts(prev), productFacts(cur),
      prisma.customer.count({ where: { createdAt: { gte: p.start, lt: p.end }, deletedAt: null } }),
      prisma.customer.count({ where: { createdAt: { gte: p.prevStart, lt: p.prevEnd }, deletedAt: null } }),
    ]);
    const F = ["revenue", "orders", "refunds", "units"] as const;
    const t = sum(sales, ...F);
    const pt = sum(prevSales, ...F);
    const sessions = sum(traffic, "sessions").sessions;
    const prevSessions = sum(prevTraffic, "sessions").sessions;

    const byDay = groupSum(sales, (r) => r.date, ["revenue", "orders"]);
    const series = p.keys.map((date) => ({ date, revenue: byDay.get(date)?.revenue ?? 0, orders: byDay.get(date)?.orders ?? 0 }));

    const byProduct = groupSum(stats, (r) => r.productId, ["units", "revenue"]);
    const info = await productInfo([...byProduct.keys()]);
    const ranked = [...byProduct].filter(([, s]) => s.revenue > 0).sort((a, b) => b[1].revenue - a[1].revenue);
    const topProducts = ranked.slice(0, 5).map(([id, s]) => {
      const i = info.get(id);
      return { id, handle: i?.handle ?? null, name: i?.name ?? "Deleted product", brand: i?.brand ?? "", imageUrl: i?.imageUrl ?? null, units: s.units, revenue: s.revenue };
    });
    const topCategories = [...groupSum(ranked.map(([id, s]) => ({ category: info.get(id)?.category ?? "Other", ...s })), (r) => r.category, ["revenue", "units"])]
      .map(([name, c]) => ({ name, ...c }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6);

    const [statusGroups, recent, conciergeGroups, conciergeOpen, lowStock] = await Promise.all([
      prisma.order.groupBy({ by: ["status"], where: { placedAt: { gte: p.start, lt: p.end } }, _count: { _all: true } }),
      prisma.order.findMany({
        orderBy: { placedAt: "desc" }, take: 8,
        select: {
          id: true, number: true, total: true, status: true, paymentStatus: true, channel: true, placedAt: true, contact: true, guestEmail: true,
          customer: { select: { id: true, firstName: true, lastName: true, email: true } }, _count: { select: { items: true } },
        },
      }),
      prisma.conciergeRequest.groupBy({ by: ["status"], where: { createdAt: { gte: p.start, lt: p.end } }, _count: { _all: true } }),
      prisma.conciergeRequest.count({ where: { status: { notIn: ["delivered", "cancelled", "unavailable"] } } }),
      prisma.$queryRaw<{ variantId: string; sku: string; size: string | null; color: string | null; productId: string; name: string; handle: string; available: bigint | number; reorderPoint: number }[]>`
        SELECT v.id AS variantId, v.sku, v.size, v.color, p.id AS productId, p.name, p.handle,
          CAST(SUM(s.onHand - s.reserved) AS SIGNED) AS available, MAX(s.reorderPoint) AS reorderPoint
        FROM StockLevel s JOIN ProductVariant v ON v.id = s.variantId JOIN Product p ON p.id = v.productId
        WHERE v.active = 1 AND p.deletedAt IS NULL AND p.status = 'active'
        GROUP BY v.id, v.sku, v.size, v.color, p.id, p.name, p.handle
        HAVING SUM(s.onHand - s.reserved) <= MAX(s.reorderPoint)
        ORDER BY available ASC, p.name ASC
        LIMIT 10`,
    ]);

    const labels = STATUS_LABELS.order.admin;
    const conciergeCounts = Object.fromEntries(conciergeGroups.map((g) => [g.status, g._count._all])) as Record<string, number>;
    const total = conciergeGroups.reduce((n, g) => n + g._count._all, 0);
    const reached = (...s: string[]) => s.reduce((n, k) => n + (conciergeCounts[k] ?? 0), 0);

    return {
      range: q.range, from: p.from, to: p.to,
      kpis: {
        revenue: kpi(t.revenue, pt.revenue),
        orders: kpi(t.orders, pt.orders),
        aov: kpi(t.orders ? Math.round(t.revenue / t.orders) : 0, pt.orders ? Math.round(pt.revenue / pt.orders) : 0),
        /** paid orders / storefront sessions */
        conversion: kpi(ratio(t.orders, sessions), ratio(pt.orders, prevSessions)),
        newCustomers: kpi(newCustomers, prevNewCustomers),
        refundRate: kpi(ratio(t.refunds, t.revenue), ratio(pt.refunds, pt.revenue)),
      },
      series,
      topProducts,
      topCategories,
      ordersByStatus: statusGroups
        .map((g) => ({ status: g.status, label: labels[g.status as keyof typeof labels] ?? g.status, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      recentOrders: recent.map((o) => {
        const contact = (o.contact ?? {}) as { email?: string; name?: string };
        return {
          id: o.id, number: o.number, total: o.total, items: o._count.items, channel: o.channel, placedAt: o.placedAt,
          status: o.status, statusLabel: labels[o.status as keyof typeof labels] ?? o.status, paymentStatus: o.paymentStatus,
          customer: o.customer ? { id: o.customer.id, name: fullName(o.customer), email: o.customer.email } : { id: null, name: contact.name ?? "Guest", email: contact.email ?? o.guestEmail ?? "" },
        };
      }),
      concierge: {
        open: conciergeOpen,
        byStatus: Object.entries(STATUS_LABELS.concierge.admin).map(([status, label]) => ({ status, label, count: conciergeCounts[status] ?? 0 })),
        /** requests created in the range that reached each stage */
        funnel: [
          { stage: "Requests", count: total },
          { stage: "Quoted", count: reached("quoted", "approved", "payment_pending", "ordered", "in_transit", "delivered") },
          { stage: "Approved", count: reached("approved", "payment_pending", "ordered", "in_transit", "delivered") },
          { stage: "Ordered", count: reached("ordered", "in_transit", "delivered") },
          { stage: "Delivered", count: reached("delivered") },
        ],
      },
      lowStock: lowStock.map((r) => ({
        variantId: r.variantId, sku: r.sku, productId: r.productId, handle: r.handle, name: r.name,
        variant: [r.color, r.size].filter(Boolean).join(" · "), available: Number(r.available), reorderPoint: Number(r.reorderPoint),
      })),
    };
  },
};
