/**
 * Reads the rollup tables for a span of days. Closed days come from the tables; TODAY is computed
 * live from the source tables (same code as the rollup job), so dashboards are current without
 * waiting for the hourly run.
 */
import { prisma } from "@/core/db/prisma";
import { dayKey, dbDate, keyOf } from "./analytics.dates";
import { computeProducts, computeSales, computeTraffic, type ProductRow, type SalesRow, type TrafficRow } from "./analytics.rollups";

type Span = { from: string; to: string };

/** closed part of the span (≤ yesterday) + whether today is inside it */
function split(span: Span) {
  const today = dayKey();
  return { closedTo: span.to >= today ? null : span.to, includesToday: span.from <= today && span.to >= today, today };
}
const closedWhere = (span: Span) => {
  const { includesToday, today } = split(span);
  return { gte: dbDate(span.from), ...(includesToday ? { lt: dbDate(today) } : { lte: dbDate(span.to) }) };
};

export async function salesFacts(span: Span, f: { channel?: string; country?: string } = {}): Promise<SalesRow[]> {
  const { includesToday, today } = split(span);
  const [stored, live] = await Promise.all([
    prisma.dailySales.findMany({
      where: { date: closedWhere(span), ...(f.channel && f.channel !== "all" ? { channel: f.channel } : {}), ...(f.country && f.country !== "all" ? { country: f.country } : {}) },
    }),
    includesToday ? computeSales(today) : Promise.resolve([] as SalesRow[]),
  ]);
  return [
    ...stored.map((r) => ({ date: keyOf(r.date), channel: r.channel, country: r.country, revenue: Number(r.revenue), orders: r.orders, refunds: Number(r.refunds), discounts: Number(r.discounts), units: r.units })),
    ...live.filter((r) => (!f.channel || f.channel === "all" || r.channel === f.channel) && (!f.country || f.country === "all" || r.country === f.country)),
  ];
}

export async function productFacts(span: Span): Promise<ProductRow[]> {
  const { includesToday, today } = split(span);
  const [stored, live] = await Promise.all([
    prisma.dailyProductStats.findMany({ where: { date: closedWhere(span) } }),
    includesToday ? computeProducts(today) : Promise.resolve([] as ProductRow[]),
  ]);
  return [
    ...stored.map((r) => ({ date: keyOf(r.date), productId: r.productId, views: r.views, addToCart: r.addToCart, units: r.units, revenue: Number(r.revenue), cost: Number(r.cost), refunds: Number(r.refunds) })),
    ...live,
  ];
}

/**
 * Traffic cells (see computeTraffic): `source` / `device` = a value, "all" (the total; default) or
 * "*" (every value, for a breakdown). Never sum visitors across "*" rows of one day.
 */
export async function trafficFacts(span: Span, cell: { device?: string; source?: string } = {}): Promise<TrafficRow[]> {
  const { includesToday, today } = split(span);
  const src = cell.source ?? "all";
  const dev = cell.device ?? "all";
  const match = (v: string, want: string) => (want === "*" ? v !== "all" : v === want);
  const where = (want: string) => (want === "*" ? { not: "all" } : want);
  const [stored, live] = await Promise.all([
    prisma.dailyTraffic.findMany({ where: { date: closedWhere(span), source: where(src), device: where(dev) } }),
    includesToday ? computeTraffic(today) : Promise.resolve([] as TrafficRow[]),
  ]);
  return [
    ...stored.map((r) => ({ date: keyOf(r.date), source: r.source, device: r.device, visitors: r.visitors, sessions: r.sessions, pageViews: r.pageViews, orders: r.orders })),
    ...live.filter((r) => match(r.source, src) && match(r.device, dev)),
  ];
}

/** sum numeric fields of rows */
export function sum<T extends Record<string, unknown>>(rows: T[], ...fields: (keyof T)[]) {
  const out = Object.fromEntries(fields.map((f) => [f, 0])) as Record<keyof T, number>;
  for (const r of rows) for (const f of fields) out[f] += Number(r[f] ?? 0);
  return out;
}

/** group rows by a key and sum fields */
export function groupSum<T extends Record<string, unknown>, K extends keyof T>(rows: T[], by: (r: T) => string, fields: K[]) {
  const m = new Map<string, Record<K, number>>();
  for (const r of rows) {
    const k = by(r);
    let a = m.get(k);
    if (!a) m.set(k, (a = Object.fromEntries(fields.map((f) => [f, 0])) as Record<K, number>));
    for (const f of fields) a[f] += Number(r[f] ?? 0);
  }
  return m;
}
