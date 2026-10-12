/**
 * Daily rollups: DailySales, DailyProductStats, DailyTraffic (one row set per Lagos day).
 *
 * Each day is rebuilt from the source tables (delete + insert in one transaction), so running a day
 * twice gives the same result and late changes (a refund on yesterday's order) are picked up by the next run.
 *
 * Definitions
 * - A sale counts on the day the order was PAID (paidAt), whatever happened later. revenue = order total
 *   (incl. shipping and VAT included in prices), discounts = order discount, units = items.
 * - Refunds count on the day the money went back: card/bank refunds (Refund rows on the order's payments)
 *   + refunds to the ASL Wallet (WalletTransaction kind refund, meta.orderNumber). Only for orders that were paid.
 * - Product cost = average StockLevel.cost of the variant (weighted by on-hand), else Product.cost, else unknown (0).
 * - Traffic: visitors = distinct anonId, sessions = distinct sessionId (server-side purchase events don't
 *   create visitors), page views = page_view events, orders = purchase events. Stored per (source, device)
 *   plus "all" totals, because distinct counts can't be summed.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { addDays, dayBounds, dayKey, dbDate, keysBetween } from "./analytics.dates";

const COUNTRY_NAMES: Record<string, string> = {
  nigeria: "NG", "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", "united states": "US",
  "united states of america": "US", usa: "US", "united arab emirates": "AE", uae: "AE", ghana: "GH",
  "south africa": "ZA", kenya: "KE", canada: "CA", france: "FR", germany: "DE", italy: "IT",
};

/** ISO-2 country of an order: pick-up = NG; ship-to country (name or code); unknown = "ZZ" */
export function orderCountry(o: { deliveryMethod: string; shippingAddress: Prisma.JsonValue | null }) {
  if (o.deliveryMethod === "pickup") return "NG";
  const c = String((o.shippingAddress as { country?: string } | null)?.country ?? "").trim();
  if (!c) return "NG";
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  return COUNTRY_NAMES[c.toLowerCase()] ?? "ZZ";
}

type RefundedOrder = {
  id: string; channel: string; deliveryMethod: string; shippingAddress: Prisma.JsonValue | null;
  items: { productId: string | null; lineTotal: number }[];
};

/** money given back on this day, per paid order */
async function refundsOn(key: string) {
  const { start, end } = dayBounds(key);
  const [card, wallet] = await Promise.all([
    prisma.refund.findMany({
      where: { createdAt: { gte: start, lt: end }, status: { not: "failed" }, payment: { orderId: { not: null } } },
      select: { amount: true, payment: { select: { orderId: true } } },
    }),
    prisma.walletTransaction.findMany({
      where: { kind: "refund", status: "completed", createdAt: { gte: start, lt: end } },
      select: { amount: true, meta: true },
    }),
  ]);
  const byId = new Map<string, number>();
  for (const r of card) byId.set(r.payment.orderId!, (byId.get(r.payment.orderId!) ?? 0) + r.amount);
  const byNumber = new Map<string, number>();
  for (const t of wallet) {
    const n = (t.meta as { orderNumber?: string } | null)?.orderNumber;
    if (n) byNumber.set(n, (byNumber.get(n) ?? 0) + Math.abs(t.amount));
  }
  if (!byId.size && !byNumber.size) return [] as { order: RefundedOrder; amount: number }[];
  const orders = await prisma.order.findMany({
    where: { paidAt: { not: null }, OR: [{ id: { in: [...byId.keys()] } }, { number: { in: [...byNumber.keys()] } }] },
    select: { id: true, number: true, channel: true, deliveryMethod: true, shippingAddress: true, items: { select: { productId: true, lineTotal: true } } },
  });
  return orders
    .map((o) => ({ order: o as RefundedOrder, amount: (byId.get(o.id) ?? 0) + (byNumber.get(o.number) ?? 0) }))
    .filter((r) => r.amount > 0);
}

const paidOn = (key: string) => {
  const { start, end } = dayBounds(key);
  return { paidAt: { gte: start, lt: end } } satisfies Prisma.OrderWhereInput;
};

export type SalesRow = { date: string; channel: string; country: string; revenue: number; orders: number; refunds: number; discounts: number; units: number };

export async function computeSales(key: string): Promise<SalesRow[]> {
  const [orders, refunds] = await Promise.all([
    prisma.order.findMany({
      where: paidOn(key),
      select: { channel: true, total: true, discount: true, deliveryMethod: true, shippingAddress: true, items: { select: { qty: true } } },
    }),
    refundsOn(key),
  ]);
  const rows = new Map<string, SalesRow>();
  const row = (channel: string, country: string) => {
    const k = `${channel}|${country}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { date: key, channel, country, revenue: 0, orders: 0, refunds: 0, discounts: 0, units: 0 }));
    return r;
  };
  for (const o of orders) {
    const r = row(o.channel, orderCountry(o));
    r.revenue += o.total;
    r.orders += 1;
    r.discounts += o.discount;
    r.units += o.items.reduce((n, i) => n + i.qty, 0);
  }
  for (const { order, amount } of refunds) row(order.channel, orderCountry(order)).refunds += amount;
  return [...rows.values()];
}

export type ProductRow = { date: string; productId: string; views: number; addToCart: number; units: number; revenue: number; cost: number; refunds: number };

/** unit cost per variant (avg StockLevel.cost weighted by on-hand) with Product.cost as fallback */
export async function unitCosts(variantIds: string[], productIds: string[]) {
  const [levels, products] = await Promise.all([
    variantIds.length ? prisma.stockLevel.findMany({ where: { variantId: { in: variantIds }, cost: { not: null } }, select: { variantId: true, cost: true, onHand: true } }) : [],
    productIds.length ? prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, cost: true } }) : [],
  ]);
  const acc = new Map<string, { w: number; sum: number }>();
  for (const l of levels) {
    const w = Math.max(1, l.onHand);
    const a = acc.get(l.variantId) ?? { w: 0, sum: 0 };
    a.w += w;
    a.sum += w * (l.cost ?? 0);
    acc.set(l.variantId, a);
  }
  const variant = new Map([...acc].map(([k, a]) => [k, Math.round(a.sum / a.w)]));
  const product = new Map(products.filter((p) => p.cost != null).map((p) => [p.id, p.cost!]));
  return (variantId: string | null, productId: string | null) =>
    (variantId ? variant.get(variantId) : undefined) ?? (productId ? product.get(productId) : undefined) ?? null;
}

export async function computeProducts(key: string): Promise<ProductRow[]> {
  const { start, end } = dayBounds(key);
  const [counts, items, refunds] = await Promise.all([
    prisma.analyticsEvent.groupBy({
      by: ["productId", "name"],
      where: { createdAt: { gte: start, lt: end }, name: { in: ["product_view", "add_to_cart"] }, productId: { not: null } },
      _count: { _all: true },
    }),
    prisma.orderItem.findMany({ where: { order: paidOn(key), productId: { not: null } }, select: { productId: true, variantId: true, qty: true, lineTotal: true } }),
    refundsOn(key),
  ]);
  const rows = new Map<string, ProductRow>();
  const row = (productId: string) => {
    let r = rows.get(productId);
    if (!r) rows.set(productId, (r = { date: key, productId, views: 0, addToCart: 0, units: 0, revenue: 0, cost: 0, refunds: 0 }));
    return r;
  };
  for (const c of counts) {
    const r = row(c.productId!);
    if (c.name === "product_view") r.views += c._count._all;
    else r.addToCart += c._count._all;
  }
  const cost = await unitCosts(
    [...new Set(items.map((i) => i.variantId).filter(Boolean) as string[])],
    [...new Set(items.map((i) => i.productId!))],
  );
  for (const i of items) {
    const r = row(i.productId!);
    r.units += i.qty;
    r.revenue += i.lineTotal;
    r.cost += (cost(i.variantId, i.productId) ?? 0) * i.qty;
  }
  // a refund is shared across the order's lines in proportion to their value
  for (const { order, amount } of refunds) {
    const lines = order.items.filter((i) => i.productId);
    const total = order.items.reduce((n, i) => n + i.lineTotal, 0);
    if (!total) continue;
    let left = Math.min(amount, total);
    lines.forEach((l, idx) => {
      const share = idx === lines.length - 1 ? left : Math.round((amount * l.lineTotal) / total);
      const v = Math.min(left, share);
      left -= v;
      row(l.productId!).refunds += v;
    });
  }
  return [...rows.values()];
}

export type TrafficRow = { date: string; source: string; device: string; visitors: number; sessions: number; pageViews: number; orders: number };

/**
 * Distinct counts don't add up across rows (one visitor can arrive from two sources), so the day is stored
 * as a small cube: (source, device) cells + (source, "all") + ("all", device) + ("all", "all") totals.
 * Readers pick the exact cell they need instead of summing.
 */
export async function computeTraffic(key: string): Promise<TrafficRow[]> {
  const { start, end } = dayBounds(key);
  const SRC = Prisma.raw("COALESCE(source, 'direct')");
  const DEV = Prisma.raw("COALESCE(device, 'desktop')");
  const ALL = Prisma.raw("'all'");
  const cube = (src: Prisma.Sql, dev: Prisma.Sql) => prisma.$queryRaw<{ source: string; device: string; visitors: bigint; sessions: bigint; pageViews: bigint | null; orders: bigint | null }[]>`
    SELECT ${src} AS source, ${dev} AS device,
      COUNT(DISTINCT CASE WHEN name <> 'purchase' THEN anonId END) AS visitors,
      COUNT(DISTINCT CASE WHEN name <> 'purchase' THEN sessionId END) AS sessions,
      CAST(SUM(name = 'page_view') AS SIGNED) AS pageViews,
      CAST(SUM(name = 'purchase') AS SIGNED) AS orders
    FROM AnalyticsEvent
    WHERE createdAt >= ${start} AND createdAt < ${end}
    GROUP BY 1, 2`;
  const parts = await Promise.all([cube(SRC, DEV), cube(SRC, ALL), cube(ALL, DEV), cube(ALL, ALL)]);
  return parts.flat()
    .filter((r) => r.visitors || r.orders) // empty day → no "all" row
    .map((r) => ({
      date: key, source: r.source, device: r.device,
      visitors: Number(r.visitors), sessions: Number(r.sessions), pageViews: Number(r.pageViews ?? 0), orders: Number(r.orders ?? 0),
    }));
}

export const rollupsService = {
  /** rebuild one Lagos day (idempotent) */
  async rebuildDay(key: string) {
    const [sales, products, traffic] = await Promise.all([computeSales(key), computeProducts(key), computeTraffic(key)]);
    const date = dbDate(key);
    await prisma.$transaction([
      prisma.dailySales.deleteMany({ where: { date } }),
      prisma.dailyProductStats.deleteMany({ where: { date } }),
      prisma.dailyTraffic.deleteMany({ where: { date } }),
      prisma.dailySales.createMany({
        data: sales.map((r) => ({ date, channel: r.channel, country: r.country, revenue: BigInt(r.revenue), orders: r.orders, refunds: BigInt(r.refunds), discounts: BigInt(r.discounts), units: r.units })),
      }),
      prisma.dailyProductStats.createMany({
        data: products.map((r) => ({ date, productId: r.productId, views: r.views, addToCart: r.addToCart, units: r.units, revenue: BigInt(r.revenue), cost: BigInt(r.cost), refunds: BigInt(r.refunds) })),
      }),
      prisma.dailyTraffic.createMany({
        data: traffic.map((r) => ({ date, source: r.source, device: r.device, visitors: r.visitors, sessions: r.sessions, pageViews: r.pageViews, orders: r.orders })),
      }),
    ]);
    return { date: key, sales: sales.length, products: products.length, traffic: traffic.length };
  },

  /** rebuild every day in [from, to] (inclusive, "YYYY-MM-DD") */
  async rebuildRange(from: string, to: string) {
    const days = keysBetween(from, to);
    for (const k of days) await this.rebuildDay(k);
    return { from, to, days: days.length };
  },
};

/** hourly: today (+ yesterday, so the first run after midnight closes the day) */
export const analyticsRollupJob = defineJob("analytics.rollup", async (d: { from?: string; to?: string } = {}) => {
  const today = dayKey();
  const r = await rollupsService.rebuildRange(d.from ?? addDays(today, -1), d.to ?? today);
  logger.info(r, "analytics.rollup");
});

/** nightly: the last 3 closed days again (late refunds, back-dated payments) */
export const analyticsRollupNightlyJob = defineJob("analytics.rollup-nightly", async () => {
  const today = dayKey();
  const r = await rollupsService.rebuildRange(addDays(today, -3), addDays(today, -1));
  logger.info(r, "analytics.rollup-nightly");
});
