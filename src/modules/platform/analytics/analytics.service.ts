/**
 * asl-admin /analytics/* screens. Business numbers come from the daily rollups (analytics.facts);
 * things the rollups can't answer (distinct visitors over a range, funnels, pages, cohorts, concierge)
 * are aggregated in SQL from the source tables.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { pageMeta } from "@/core/http/pagination";
import { addMonths, dayKey, delta, monthKey, monthLabel, monthsBetween, periodOf, ratio, type Period } from "./analytics.dates";
import { groupSum, productFacts, salesFacts, sum, trafficFacts } from "./analytics.facts";
import { hostOf } from "./analytics.ingest";
import { SOURCES, type CohortsQuery, type ConciergeQuery, type ProductsQuery, type SalesQuery, type TrafficQuery } from "./analytics.schemas";

export const CHANNELS = ["web", "mobile", "pwa", "concierge", "draft"] as const;

const kpi = (value: number, previous: number) => ({ value, previous, delta: delta(value, previous) });
const span = (p: Period) => ({ from: p.from, to: p.to });
const prevSpan = (p: Period) => ({ from: p.prevFrom, to: p.prevTo });

/** name / brand / category / image for product ids */
export async function productInfo(ids: string[]) {
  if (!ids.length) return new Map<string, ProductInfo>();
  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, handle: true, name: true, price: true, cost: true,
      brand: { select: { name: true } }, category: { select: { name: true, handle: true } },
      images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
    },
  });
  return new Map(
    rows.map((p) => [p.id, {
      id: p.id, handle: p.handle, name: p.name, brand: p.brand.name, category: p.category.name, categoryHandle: p.category.handle,
      imageUrl: p.images[0]?.url ?? null, price: p.price, cost: p.cost,
    }]),
  );
}
export type ProductInfo = { id: string; handle: string; name: string; brand: string; category: string; categoryHandle: string; imageUrl: string | null; price: number; cost: number | null };

/** null when the cost isn't known */
const marginOf = (revenue: number, cost: number) => (revenue > 0 && cost > 0 ? ratio(revenue - cost, revenue) : null);

/** WHERE fragment for raw event queries */
function eventWhere(start: Date, end: Date, f: { device?: string; source?: string }) {
  return Prisma.sql`createdAt >= ${start} AND createdAt < ${end}
    ${f.device && f.device !== "all" ? Prisma.sql`AND device = ${f.device}` : Prisma.empty}
    ${f.source && f.source !== "all" ? Prisma.sql`AND source = ${f.source}` : Prisma.empty}`;
}

async function trafficTotals(start: Date, end: Date, f: { device?: string; source?: string }) {
  const w = eventWhere(start, end, f);
  const [t] = await prisma.$queryRaw<{ visitors: bigint; sessions: bigint; pageviews: bigint | null }[]>`
    SELECT COUNT(DISTINCT CASE WHEN name <> 'purchase' THEN anonId END) AS visitors,
      COUNT(DISTINCT CASE WHEN name <> 'purchase' THEN sessionId END) AS sessions,
      CAST(SUM(name = 'page_view') AS SIGNED) AS pageviews
    FROM AnalyticsEvent WHERE ${w}`;
  const [s] = await prisma.$queryRaw<{ sessions: bigint; bounces: bigint | null; avgSec: number | string | null }[]>`
    SELECT COUNT(*) AS sessions, CAST(SUM(pv <= 1 AND n = 1) AS SIGNED) AS bounces, AVG(dur) AS avgSec FROM (
      SELECT sessionId, SUM(name = 'page_view') AS pv, COUNT(*) AS n, TIMESTAMPDIFF(SECOND, MIN(createdAt), MAX(createdAt)) AS dur
      FROM AnalyticsEvent WHERE ${w} AND name <> 'purchase' GROUP BY sessionId) x`;
  return {
    visitors: Number(t.visitors), sessions: Number(t.sessions), pageviews: Number(t.pageviews ?? 0),
    bounces: Number(s.bounces ?? 0), avgSessionSec: Math.round(Number(s.avgSec ?? 0)),
  };
}

export const analyticsService = {
  // ── /analytics/sales ──
  async sales(q: SalesQuery) {
    const p = periodOf(q.range);
    const [cur, prev, traffic, stats] = await Promise.all([
      salesFacts(span(p), q), salesFacts(prevSpan(p), q), trafficFacts(span(p)), productFacts(span(p)),
    ]);
    const F = ["revenue", "orders", "refunds", "discounts", "units"] as const;
    const t = sum(cur, ...F);
    const pt = sum(prev, ...F);
    const visitors = sum(traffic, "visitors").visitors;

    const byDay = groupSum(cur, (r) => r.date, [...F]);
    const visitorsByDay = groupSum(traffic, (r) => r.date, ["visitors"]);
    const series = p.keys.map((date) => {
      const d = byDay.get(date);
      const revenue = d?.revenue ?? 0;
      return { date, revenue, orders: d?.orders ?? 0, refunds: d?.refunds ?? 0, discounts: d?.discounts ?? 0, net: revenue - (d?.refunds ?? 0), visitors: visitorsByDay.get(date)?.visitors ?? 0 };
    });

    const byChannel = groupSum(cur, (r) => r.channel, ["revenue", "orders", "refunds"]);
    const channels = [...new Set([...CHANNELS.filter((c) => c !== "draft"), ...byChannel.keys()])].map((channel) => {
      const c = byChannel.get(channel) ?? { revenue: 0, orders: 0, refunds: 0 };
      return { channel, revenue: c.revenue, orders: c.orders, refunds: c.refunds, aov: c.orders ? Math.round(c.revenue / c.orders) : 0, share: ratio(c.revenue, t.revenue) };
    });
    const countries = [...groupSum(cur, (r) => r.country, ["revenue", "orders"])]
      .map(([country, c]) => ({ country, revenue: c.revenue, orders: c.orders, share: ratio(c.revenue, t.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);

    // categories + product table (product rollups have no channel / country dimension)
    const byProduct = groupSum(stats, (r) => r.productId, ["units", "revenue", "cost", "refunds"]);
    const info = await productInfo([...byProduct.keys()]);
    const productRows = [...byProduct]
      .filter(([, s]) => s.units > 0 || s.revenue > 0)
      .map(([id, s]) => {
        const i = info.get(id);
        return {
          id, handle: i?.handle ?? null, name: i?.name ?? "Deleted product", brand: i?.brand ?? "", category: i?.category ?? "",
          units: s.units, revenue: s.revenue, refundRate: ratio(s.refunds, s.revenue), margin: marginOf(s.revenue, s.cost),
        };
      })
      .sort((a, b) => b.revenue - a.revenue);
    const categories = [...groupSum(productRows, (r) => r.category || "Other", ["revenue", "units"])]
      .map(([name, c]) => ({ name, revenue: c.revenue, units: c.units }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      range: q.range, from: p.from, to: p.to, filters: { channel: q.channel, country: q.country },
      kpis: {
        revenue: kpi(t.revenue, pt.revenue),
        net: kpi(t.revenue - t.refunds, pt.revenue - pt.refunds),
        orders: kpi(t.orders, pt.orders),
        aov: kpi(t.orders ? Math.round(t.revenue / t.orders) : 0, pt.orders ? Math.round(pt.revenue / pt.orders) : 0),
        refunds: kpi(t.refunds, pt.refunds),
        discounts: kpi(t.discounts, pt.discounts),
        units: kpi(t.units, pt.units),
        refundRate: kpi(ratio(t.refunds, t.revenue), ratio(pt.refunds, pt.revenue)),
      },
      totalRevenue: t.revenue, totalOrders: t.orders, visitors,
      series, channels, countries, categories, products: productRows.slice(0, 50),
    };
  },

  // ── /analytics/products ──
  async products(q: ProductsQuery) {
    const p = periodOf(q.range);
    const category = q.category !== "all" ? await prisma.category.findFirst({ where: { OR: [{ id: q.category }, { handle: q.category }] }, select: { id: true } }) : null;
    const [products, cur, prev, searches, zero] = await Promise.all([
      prisma.product.findMany({
        where: { deletedAt: null, status: { not: "archived" }, ...(q.category !== "all" ? { categoryId: category?.id ?? "-" } : {}) },
        select: {
          id: true, handle: true, name: true, price: true, cost: true, status: true,
          brand: { select: { name: true } }, category: { select: { name: true, handle: true } },
          images: { select: { url: true }, orderBy: { position: "asc" }, take: 1 },
          variants: { select: { stock: { select: { onHand: true, reserved: true } } } },
        },
      }),
      productFacts(span(p)),
      productFacts(prevSpan(p)),
      prisma.searchLog.groupBy({ by: ["query"], where: { createdAt: { gte: p.start, lt: p.end } }, _count: { _all: true }, _avg: { results: true }, orderBy: { _count: { query: "desc" } }, take: 10 }),
      prisma.searchLog.groupBy({ by: ["query"], where: { createdAt: { gte: p.start, lt: p.end }, results: 0 }, _count: { _all: true }, orderBy: { _count: { query: "desc" } }, take: 10 }),
    ]);
    const F = ["views", "addToCart", "units", "revenue", "cost", "refunds"] as const;
    const now = groupSum(cur, (r) => r.productId, [...F]);
    const before = groupSum(prev, (r) => r.productId, ["revenue"]);
    const zeroStats = { views: 0, addToCart: 0, units: 0, revenue: 0, cost: 0, refunds: 0 };

    const rows = products.map((pr) => {
      const s = now.get(pr.id) ?? zeroStats;
      const prevRevenue = before.get(pr.id)?.revenue ?? 0;
      const stock = pr.variants.reduce((n, v) => n + v.stock.reduce((m, l) => m + Math.max(0, l.onHand - l.reserved), 0), 0);
      const grossMargin = marginOf(s.revenue, s.cost) ?? (pr.cost ? ratio(pr.price - pr.cost, pr.price) : null);
      const change = delta(s.revenue, prevRevenue);
      return {
        id: pr.id, handle: pr.handle, name: pr.name, brand: pr.brand.name, category: pr.category.name, categoryHandle: pr.category.handle,
        imageUrl: pr.images[0]?.url ?? null, status: pr.status, price: pr.price, cost: pr.cost, stock,
        units: s.units, revenue: s.revenue, views: s.views, addToCart: s.addToCart,
        conv: s.views ? ratio(s.units, s.views) : null, grossMargin, refundRate: ratio(s.refunds, s.revenue),
        trend: (s.revenue >= prevRevenue ? "up" : "down") as "up" | "down", trendPct: change === null ? null : Math.abs(change),
        turnover: stock ? ratio(s.units, stock) : null,
        daysOnHand: s.units > 0 ? Math.round((stock / s.units) * p.days) : null,
      };
    });

    const key = { revenue: "revenue", units: "units", views: "views", conv: "conv", margin: "grossMargin" }[q.sort] as "revenue" | "units" | "views" | "conv" | "grossMargin";
    const sorted = [...rows].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || b.revenue - a.revenue);
    const total = sum(rows, "revenue", "units", "views", "cost");
    const withCost = rows.filter((r) => r.revenue > 0 && (now.get(r.id)?.cost ?? 0) > 0);
    const costed = sum(withCost, "revenue").revenue;
    const costedCost = withCost.reduce((n, r) => n + now.get(r.id)!.cost, 0);

    const categories = [...groupSum(rows, (r) => r.category, ["revenue", "units", "views"])].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.revenue - a.revenue);
    const brands = [...groupSum(rows, (r) => r.brand, ["revenue", "units"])].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.revenue - a.revenue).slice(0, 8);
    const slowMovers = rows
      .filter((r) => r.stock > 0)
      .sort((a, b) => (b.daysOnHand ?? Infinity) - (a.daysOnHand ?? Infinity) || b.stock - a.stock)
      .slice(0, 6);

    return {
      range: q.range, from: p.from, to: p.to,
      totalRevenue: total.revenue, totalUnits: total.units, totalViews: total.views,
      avgConv: ratio(total.units, total.views),
      /** revenue-weighted, over products whose cost is known */
      avgMargin: costed ? ratio(costed - costedCost, costed) : null,
      liveCount: products.filter((r) => r.status === "active").length,
      lowStock: rows.filter((r) => r.stock > 0 && r.stock <= 5).length,
      outOfStock: rows.filter((r) => r.stock === 0).length,
      rows: sorted.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      pagination: pageMeta(q, rows.length),
      categories, brands, slowMovers,
      topSearches: searches.map((s) => ({ term: s.query, volume: s._count._all, results: Math.round(s._avg.results ?? 0) })),
      zeroResults: zero.map((s) => ({ term: s.query, volume: s._count._all })),
    };
  },

  // ── /analytics/traffic ──
  async traffic(q: TrafficQuery) {
    const p = periodOf(q.range);
    const f = { device: q.device, source: q.source };
    const w = eventWhere(p.start, p.end, f);
    const [daily, bySource, byDevice, totals, prevTotals, pages, refs, countries, funnel] = await Promise.all([
      trafficFacts(span(p), f),
      trafficFacts(span(p), { device: q.device, source: "*" }),
      trafficFacts(span(p), { source: q.source, device: "*" }),
      trafficTotals(p.start, p.end, f),
      trafficTotals(p.prevStart, p.prevEnd, f),
      prisma.$queryRaw<{ path: string; views: bigint; visitors: bigint }[]>`
        SELECT path, COUNT(*) AS views, COUNT(DISTINCT anonId) AS visitors FROM AnalyticsEvent
        WHERE ${w} AND name = 'page_view' AND path IS NOT NULL GROUP BY path ORDER BY views DESC LIMIT 10`,
      prisma.$queryRaw<{ referrer: string; visitors: bigint }[]>`
        SELECT referrer, COUNT(DISTINCT anonId) AS visitors FROM AnalyticsEvent
        WHERE ${w} AND referrer IS NOT NULL GROUP BY referrer ORDER BY visitors DESC LIMIT 500`,
      prisma.$queryRaw<{ country: string | null; visitors: bigint }[]>`
        SELECT country, COUNT(DISTINCT anonId) AS visitors FROM AnalyticsEvent
        WHERE ${w} AND name <> 'purchase' GROUP BY country ORDER BY visitors DESC LIMIT 20`,
      prisma.$queryRaw<{ name: string; visitors: bigint }[]>`
        SELECT name, COUNT(DISTINCT anonId) AS visitors FROM AnalyticsEvent WHERE ${w} GROUP BY name`,
    ]);

    const byDay = groupSum(daily, (r) => r.date, ["visitors", "sessions", "pageViews", "orders"]);
    const series = p.keys.map((date) => {
      const d = byDay.get(date);
      return { date, visitors: d?.visitors ?? 0, sessions: d?.sessions ?? 0, pageviews: d?.pageViews ?? 0, orders: d?.orders ?? 0 };
    });
    const srcTotals = sum(bySource, "visitors");
    const src = groupSum(bySource, (r) => r.source, ["visitors", "sessions", "orders"]);
    const sources = SOURCES.map((source) => {
      const s = src.get(source) ?? { visitors: 0, sessions: 0, orders: 0 };
      return { source, visitors: s.visitors, sessions: s.sessions, orders: s.orders, conv: ratio(s.orders, s.sessions), share: ratio(s.visitors, srcTotals.visitors) };
    });
    const devTotals = sum(byDevice, "visitors");
    const dev = groupSum(byDevice, (r) => r.device, ["visitors", "sessions", "orders"]);
    const devices = (["mobile", "desktop", "tablet"] as const).map((device) => {
      const d = dev.get(device) ?? { visitors: 0, sessions: 0, orders: 0 };
      return { device, visitors: d.visitors, sessions: d.sessions, orders: d.orders, share: ratio(d.visitors, devTotals.visitors) };
    });
    const hosts = new Map<string, number>();
    for (const r of refs) {
      const h = hostOf(r.referrer);
      if (h) hosts.set(h, (hosts.get(h) ?? 0) + Number(r.visitors));
    }
    const fn = new Map(funnel.map((r) => [r.name, Number(r.visitors)]));
    const orders = sum(daily, "orders").orders;

    return {
      range: q.range, from: p.from, to: p.to, filters: f,
      totalVisitors: totals.visitors, totalSessions: totals.sessions, totalPageviews: totals.pageviews,
      bounceRate: ratio(totals.bounces, totals.sessions), avgSessionSec: totals.avgSessionSec,
      pagesPerSession: ratio(totals.pageviews, totals.sessions, 2), conversion: ratio(orders, totals.sessions),
      kpis: {
        visitors: kpi(totals.visitors, prevTotals.visitors),
        sessions: kpi(totals.sessions, prevTotals.sessions),
        pageviews: kpi(totals.pageviews, prevTotals.pageviews),
        bounceRate: kpi(ratio(totals.bounces, totals.sessions), ratio(prevTotals.bounces, prevTotals.sessions)),
        avgSessionSec: kpi(totals.avgSessionSec, prevTotals.avgSessionSec),
      },
      series, sources, devices,
      countries: countries.map((c) => ({ country: c.country ?? "ZZ", visitors: Number(c.visitors) })),
      pages: pages.map((r) => ({ path: r.path, views: Number(r.views), visitors: Number(r.visitors) })),
      referrers: [...hosts].map(([host, visitors]) => ({ host, visitors })).sort((a, b) => b.visitors - a.visitors).slice(0, 10),
      funnel: [
        { stage: "Visitors", value: totals.visitors },
        { stage: "Product view", value: fn.get("product_view") ?? 0 },
        { stage: "Added to cart", value: fn.get("add_to_cart") ?? 0 },
        { stage: "Checkout", value: fn.get("checkout_start") ?? 0 },
        { stage: "Purchase", value: fn.get("purchase") ?? 0 },
      ],
    };
  },

  // ── /analytics/cohorts: monthly sign-up cohorts × months since sign-up ──
  async cohorts(q: CohortsQuery) {
    const size = { "6m": 6, "12m": 12, "24m": 24 }[q.window];
    const current = monthKey(new Date());
    const first = addMonths(current, -(size - 1));
    const since = new Date(Date.parse(`${first}-01T00:00:00Z`) - 3_600_000); // Lagos midnight
    const [signups, buys] = await Promise.all([
      prisma.$queryRaw<{ m: string; n: bigint }[]>`
        SELECT DATE_FORMAT(DATE_ADD(createdAt, INTERVAL 1 HOUR), '%Y-%m') AS m, COUNT(*) AS n
        FROM Customer WHERE createdAt >= ${since} GROUP BY m`,
      prisma.$queryRaw<{ m: string; om: string; buyers: bigint; orders: bigint; revenue: bigint | number | string }[]>`
        SELECT DATE_FORMAT(DATE_ADD(c.createdAt, INTERVAL 1 HOUR), '%Y-%m') AS m,
          DATE_FORMAT(DATE_ADD(o.paidAt, INTERVAL 1 HOUR), '%Y-%m') AS om,
          COUNT(DISTINCT o.customerId) AS buyers, COUNT(*) AS orders, CAST(SUM(o.total) AS SIGNED) AS revenue
        FROM \`Order\` o JOIN Customer c ON c.id = o.customerId
        WHERE o.paidAt IS NOT NULL AND c.createdAt >= ${since}
        GROUP BY m, om`,
    ]);
    const newBy = new Map(signups.map((s) => [s.m, Number(s.n)]));
    const cell = new Map(buys.map((b) => [`${b.m}|${monthsBetween(b.m, b.om)}`, { buyers: Number(b.buyers), orders: Number(b.orders), revenue: Number(b.revenue) }]));

    const matrix = (fnc: (c: { buyers: number; orders: number; revenue: number }, n: number) => number) =>
      Array.from({ length: size }, (_, i) => {
        const mk = addMonths(first, i);
        const n = newBy.get(mk) ?? 0;
        const row = Array.from({ length: size }, (_, m) => (m > monthsBetween(mk, current) ? null : fnc(cell.get(`${mk}|${m}`) ?? { buyers: 0, orders: 0, revenue: 0 }, n)));
        return { month: mk, label: monthLabel(mk), newCustomers: n, row };
      });
    const retention = matrix((c, n) => ratio(c.buyers, n));
    const pick = { retention, orders: matrix((c) => c.orders), revenue: matrix((c) => c.revenue) }[q.metric];
    const revenue = q.metric === "revenue" ? pick : matrix((c) => c.revenue);

    /** average over cohorts that have reached month m (per customer for orders / revenue) */
    const avgAt = (rows: typeof retention, m: number, perCustomer: boolean) => {
      const vals = rows.filter((c) => c.row[m] !== null && c.newCustomers > 0).map((c) => (perCustomer ? c.row[m]! / c.newCustomers : c.row[m]!));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const curve = Array.from({ length: size }, (_, m) => ({ month: m, value: avgAt(pick, m, q.metric !== "retention") }))
      .filter((c) => c.value !== null)
      .map((c) => ({ month: c.month, value: Math.round(c.value! * 10_000) / 10_000 }));
    let cum = 0;
    const ltv = Array.from({ length: size }, (_, m) => {
      cum += avgAt(revenue, m, true) ?? 0;
      return { month: m, ltv: Math.round(cum) };
    });
    const r = (m: number) => {
      const v = avgAt(retention, m, false);
      return v === null ? null : Math.round(v * 10_000) / 10_000;
    };

    // segments (lifetime stats)
    const recent = new Date(Date.now() - 90 * 86_400_000);
    const vipIds = (await prisma.conciergeRequest.findMany({ where: { priority: "vip", customerId: { not: null } }, distinct: ["customerId"], select: { customerId: true } })).map((x) => x.customerId!);
    const seg = async (name: string, where: Prisma.CustomerStatsWhereInput) => {
      const [agg, active] = await Promise.all([
        prisma.customerStats.aggregate({ where, _count: { _all: true }, _avg: { totalSpend: true } }),
        prisma.customerStats.count({ where: { AND: [where, { lastOrderAt: { gte: recent } }] } }),
      ]);
      return { name, size: agg._count._all, retention: ratio(active, agg._count._all), ltv: Math.round(Number(agg._avg.totalSpend ?? 0)) };
    };
    const segments = await Promise.all([
      seg("First-time buyers", { ordersCount: 1 }),
      seg("Repeat customers", { ordersCount: { gte: 2 } }),
      seg("ASL Club members", { ordersCount: { gte: 1 }, customer: { tier: { not: "Standard" } } }),
      seg("VIP concierge", { customerId: { in: vipIds.length ? vipIds : ["-"] } }),
    ]);

    return {
      window: q.window, metric: q.metric, size,
      cohorts: pick, curve, ltv, segments,
      totalNew: pick.reduce((n, c) => n + c.newCustomers, 0),
      m1: r(1), m3: r(3), m6: r(6), m12: r(12),
    };
  },

  // ── /analytics/concierge (requests created in the range) ──
  async concierge(q: ConciergeQuery) {
    const p = periodOf(q.range);
    const where: Prisma.ConciergeRequestWhereInput = { createdAt: { gte: p.start, lt: p.end }, ...(q.priority !== "all" ? { priority: q.priority } : {}) };
    const reqs = await prisma.conciergeRequest.findMany({
      where,
      select: {
        id: true, createdAt: true, updatedAt: true, status: true, category: true, assigneeId: true, slaState: true,
        supplier: { select: { id: true, name: true } },
        quotes: { select: { createdAt: true, status: true, amountPaid: true, paidAt: true, declineReason: true }, orderBy: { createdAt: "asc" } },
        thread: { select: { messages: { where: { sender: "agent" }, orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } } },
      },
    });
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const paidOf = (r: (typeof reqs)[number]) => r.quotes.reduce((n, x) => n + x.amountPaid, 0);
    const converted = (r: (typeof reqs)[number]) => r.quotes.some((x) => x.status === "paid" || x.amountPaid > 0);
    const firstResponse = (r: (typeof reqs)[number]) => {
      const t = r.thread?.messages[0]?.createdAt;
      return t ? (t.getTime() - r.createdAt.getTime()) / 60_000 : null;
    };

    const quoted = reqs.filter((r) => r.quotes.length);
    const won = reqs.filter(converted);
    const gmv = won.reduce((n, r) => n + paidOf(r), 0);
    const quotesSent = reqs.reduce((n, r) => n + r.quotes.length, 0);

    const series = p.keys.map((date) => ({ date, requests: 0, quotes: 0, converted: 0, revenue: 0 }));
    const idx = new Map(series.map((s, i) => [s.date, i]));
    for (const r of reqs) {
      const s = series[idx.get(dayKey(r.createdAt))!];
      if (s) s.requests++;
      for (const x of r.quotes) {
        const qs = series[idx.get(dayKey(x.createdAt)) ?? -1];
        if (qs) qs.quotes++;
        if (x.paidAt) {
          const ps = series[idx.get(dayKey(x.paidAt)) ?? -1];
          if (ps) {
            ps.converted++;
            ps.revenue += x.amountPaid;
          }
        }
      }
    }

    const byStatus = Object.fromEntries(["new", "sourcing", "quoted", "approved", "payment_pending", "ordered", "in_transit", "delivered", "cancelled", "unavailable"].map((s) => [s, 0]));
    for (const r of reqs) byStatus[r.status]++;

    const group = <K extends string>(key: (r: (typeof reqs)[number]) => K | null) => {
      const m = new Map<K, typeof reqs>();
      for (const r of reqs) {
        const k = key(r);
        if (k === null) continue;
        m.set(k, [...(m.get(k) ?? []), r]);
      }
      return m;
    };
    const agentRows = group((r) => r.assigneeId);
    const admins = await prisma.adminUser.findMany({ where: { id: { in: [...agentRows.keys()] } }, select: { id: true, name: true } });
    const agentName = new Map(admins.map((a) => [a.id, a.name]));

    const reasons = new Map<string, number>();
    for (const r of reqs) {
      for (const x of r.quotes) if (x.status === "declined") reasons.set(x.declineReason || "Declined (no reason)", (reasons.get(x.declineReason || "Declined (no reason)") ?? 0) + 1);
      if (r.status === "unavailable") reasons.set("No stock worldwide", (reasons.get("No stock worldwide") ?? 0) + 1);
      if (r.status === "cancelled") reasons.set("Cancelled", (reasons.get("Cancelled") ?? 0) + 1);
    }
    const lost = [...reasons.values()].reduce((a, b) => a + b, 0);
    const delivered = reqs.filter((r) => r.status === "delivered");

    return {
      range: q.range, from: p.from, to: p.to, priority: q.priority,
      totalRequests: reqs.length, quotedRequests: quoted.length, totalQuotes: quotesSent, totalConverted: won.length,
      gmv, aov: won.length ? Math.round(gmv / won.length) : 0,
      /** paid / quoted requests */
      conversion: ratio(won.length, quoted.length),
      requestConversion: ratio(won.length, reqs.length),
      slaPct: ratio(reqs.filter((r) => r.slaState !== "breached").length, reqs.length),
      firstResponseMin: (() => {
        const v = avg(reqs.map(firstResponse).filter((x): x is number => x !== null));
        return v === null ? null : Math.round(v);
      })(),
      avgQuoteHours: (() => {
        const v = avg(quoted.map((r) => (r.quotes[0].createdAt.getTime() - r.createdAt.getTime()) / 3_600_000));
        return v === null ? null : Math.round(v * 10) / 10;
      })(),
      avgFulfillmentDays: (() => {
        const v = avg(delivered.map((r) => (r.updatedAt.getTime() - r.createdAt.getTime()) / 86_400_000));
        return v === null ? null : Math.round(v * 10) / 10;
      })(),
      openRequests: reqs.filter((r) => !["delivered", "cancelled", "unavailable"].includes(r.status)).length,
      series, byStatus,
      stages: [
        { stage: "New", count: reqs.length },
        { stage: "Sourcing", count: reqs.filter((r) => r.status !== "new").length },
        { stage: "Quoted", count: quoted.length },
        { stage: "Approved", count: reqs.filter((r) => r.quotes.some((x) => ["accepted", "paid"].includes(x.status))).length },
        { stage: "Fulfilled", count: delivered.length },
      ],
      categories: [...group((r) => r.category)].map(([name, rs]) => ({ name, requests: rs.length, converted: rs.filter(converted).length })).sort((a, b) => b.requests - a.requests),
      agents: [...agentRows].map(([id, rs]) => {
        const w = rs.filter(converted);
        const fr = avg(rs.map(firstResponse).filter((x): x is number => x !== null));
        return { id, name: agentName.get(id) ?? "Former staff", handled: rs.length, converted: w.length, conv: ratio(w.length, rs.length), firstResponseMin: fr === null ? null : Math.round(fr), revenue: w.reduce((n, r) => n + paidOf(r), 0) };
      }).sort((a, b) => b.revenue - a.revenue),
      suppliers: [...group((r) => r.supplier?.id ?? null)].map(([id, rs]) => ({
        id, name: rs[0].supplier!.name, handled: rs.length, fulfilled: rs.filter((r) => r.status === "delivered").length, revenue: rs.reduce((n, r) => n + paidOf(r), 0),
      })).sort((a, b) => b.handled - a.handled),
      reasons: [...reasons].map(([reason, count]) => ({ reason, count, pct: ratio(count, lost) })).sort((a, b) => b.count - a.count),
    };
  },
};
