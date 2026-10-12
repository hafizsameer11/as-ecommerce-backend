/**
 * Code-defined report generators. Each returns plain rows + typed columns; reports.render.ts turns
 * them into CSV / XLSX / PDF. Money stays in kobo here (the renderer prints naira).
 * `finance: true` generators need the finance.view permission to create, run or download.
 */
import { prisma } from "@/core/db/prisma";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { addDays, addMonths, dayBounds, dayKey, dayStart, periodOf, type Range } from "@/modules/platform/analytics/analytics.dates";
import { salesFacts } from "@/modules/platform/analytics/analytics.facts";
import { orderCountry } from "@/modules/platform/analytics/analytics.rollups";
import type { GeneratorKey, ReportParams } from "./reports.schemas";

export type ColumnType = "text" | "int" | "money" | "date" | "datetime" | "pct" | "bool";
export type Column = { key: string; label: string; type: ColumnType; width?: number };
export type Row = Record<string, string | number | boolean | Date | null>;
export type ReportData = { title: string; period: string | null; columns: Column[]; rows: Row[]; totals?: Row };

type Span = { from: string; to: string; start: Date; end: Date; label: string };

/** resolve params (or the generator default) to Lagos days */
export function resolveSpan(p: ReportParams, fallback: NonNullable<ReportParams["range"]>, now = new Date()): Span {
  const today = dayKey(now);
  let from: string;
  let to: string;
  if (p.from || p.to) {
    from = p.from ?? p.to!;
    to = p.to ?? today;
  } else {
    const range = p.range ?? fallback;
    if (range === "mtd") [from, to] = [`${today.slice(0, 7)}-01`, today];
    else if (range === "last_month") {
      const m = addMonths(today.slice(0, 7), -1);
      from = `${m}-01`;
      to = addDays(`${today.slice(0, 7)}-01`, -1);
    } else if (range === "yesterday") from = to = addDays(today, -1);
    else ({ from, to } = periodOf(range as Range, now));
  }
  return { from, to, start: dayStart(from), end: dayBounds(to).end, label: from === to ? from : `${from} – ${to}` };
}

const MAX_ROWS = 50_000;
const sumOf = (rows: Row[], key: string) => rows.reduce((n, r) => n + Number(r[key] ?? 0), 0);
const totalsOf = (rows: Row[], label: string, keys: string[]): Row => ({ ...Object.fromEntries(keys.map((k) => [k, sumOf(rows, k)])), _label: label });

type Generator = {
  key: GeneratorKey;
  label: string;
  description: string;
  category: "sales" | "finance" | "customers" | "catalog" | "concierge" | "operations" | "tax";
  finance: boolean;
  /** default period (null = snapshot "as of now") */
  defaultRange: NonNullable<ReportParams["range"]> | null;
  build: (p: ReportParams) => Promise<ReportData>;
};

export const GENERATORS: Record<GeneratorKey, Generator> = {
  sales_summary: {
    key: "sales_summary", label: "Sales summary", category: "sales", finance: false, defaultRange: "30d",
    description: "Gross, discounts, refunds, net, orders, units and AOV per day and channel (from the daily rollups).",
    async build(p) {
      const s = resolveSpan(p, "30d");
      const facts = await salesFacts({ from: s.from, to: s.to });
      const m = new Map<string, Row>();
      for (const f of facts) {
        const k = `${f.date}|${f.channel}`;
        const r = m.get(k) ?? { date: f.date, channel: f.channel, orders: 0, units: 0, gross: 0, discounts: 0, refunds: 0, net: 0, aov: 0 };
        r.orders = Number(r.orders) + f.orders;
        r.units = Number(r.units) + f.units;
        r.gross = Number(r.gross) + f.revenue;
        r.discounts = Number(r.discounts) + f.discounts;
        r.refunds = Number(r.refunds) + f.refunds;
        m.set(k, r);
      }
      const rows = [...m.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.channel).localeCompare(String(b.channel)));
      for (const r of rows) {
        r.net = Number(r.gross) - Number(r.refunds);
        r.aov = Number(r.orders) ? Math.round(Number(r.gross) / Number(r.orders)) : 0;
      }
      const totals = totalsOf(rows, "Total", ["orders", "units", "gross", "discounts", "refunds", "net"]);
      totals.aov = Number(totals.orders) ? Math.round(Number(totals.gross) / Number(totals.orders)) : 0;
      return {
        title: "Sales summary", period: s.label, rows, totals,
        columns: [
          { key: "date", label: "Date", type: "text", width: 12 }, { key: "channel", label: "Channel", type: "text", width: 11 },
          { key: "orders", label: "Orders", type: "int" }, { key: "units", label: "Units", type: "int" },
          { key: "gross", label: "Gross", type: "money" }, { key: "discounts", label: "Discounts", type: "money" },
          { key: "refunds", label: "Refunds", type: "money" }, { key: "net", label: "Net", type: "money" }, { key: "aov", label: "AOV", type: "money" },
        ],
      };
    },
  },

  vat_report: {
    key: "vat_report", label: "VAT report", category: "tax", finance: true, defaultRange: "last_month",
    description: "Paid orders with VAT included in prices and VAT added, for filing.",
    async build(p) {
      const s = resolveSpan(p, "last_month");
      const orders = await prisma.order.findMany({
        where: { paidAt: { gte: s.start, lt: s.end } }, orderBy: { paidAt: "asc" }, take: MAX_ROWS,
        select: { number: true, paidAt: true, channel: true, deliveryMethod: true, shippingAddress: true, subtotal: true, discount: true, shipping: true, tax: true, taxIncluded: true, total: true, amountRefunded: true },
      });
      const rows: Row[] = orders.map((o) => ({
        paidAt: dayKey(o.paidAt!), number: o.number, channel: o.channel, country: orderCountry(o),
        subtotal: o.subtotal, discount: o.discount, shipping: o.shipping, vatIncluded: o.taxIncluded, vatAdded: o.tax,
        vat: o.taxIncluded + o.tax, total: o.total, netOfVat: o.total - o.taxIncluded - o.tax, refunded: o.amountRefunded,
      }));
      return {
        title: "VAT report", period: s.label, rows,
        totals: totalsOf(rows, "Total", ["subtotal", "discount", "shipping", "vatIncluded", "vatAdded", "vat", "total", "netOfVat", "refunded"]),
        columns: [
          { key: "paidAt", label: "Paid", type: "text", width: 11 }, { key: "number", label: "Order", type: "text", width: 16 },
          { key: "channel", label: "Channel", type: "text", width: 9 }, { key: "country", label: "Country", type: "text", width: 7 },
          { key: "subtotal", label: "Subtotal", type: "money" }, { key: "discount", label: "Discount", type: "money" }, { key: "shipping", label: "Shipping", type: "money" },
          { key: "vatIncluded", label: "VAT included", type: "money" }, { key: "vatAdded", label: "VAT added", type: "money" }, { key: "vat", label: "VAT total", type: "money" },
          { key: "total", label: "Total", type: "money" }, { key: "netOfVat", label: "Net of VAT", type: "money" }, { key: "refunded", label: "Refunded", type: "money" },
        ],
      };
    },
  },

  wallet_liabilities: {
    key: "wallet_liabilities", label: "Wallet liabilities", category: "finance", finance: true, defaultRange: null,
    description: "Customer ASL Wallet balances owed (as of the run), largest first.",
    async build() {
      const wallets = await prisma.wallet.findMany({
        where: { OR: [{ balance: { not: 0 } }, { held: { not: 0 } }] }, orderBy: { balance: "desc" }, take: MAX_ROWS,
        select: { balance: true, held: true, frozen: true, updatedAt: true, customer: { select: { firstName: true, lastName: true, email: true, tier: true } } },
      });
      const rows: Row[] = wallets.map((w) => ({
        customer: fullName(w.customer), email: w.customer.email, tier: w.customer.tier, balance: w.balance, held: w.held, frozen: w.frozen, lastMovement: w.updatedAt,
      }));
      return {
        title: "Wallet liabilities", period: `As of ${dayKey()}`, rows, totals: totalsOf(rows, "Total", ["balance", "held"]),
        columns: [
          { key: "customer", label: "Customer", type: "text", width: 22 }, { key: "email", label: "Email", type: "text", width: 28 }, { key: "tier", label: "Tier", type: "text", width: 10 },
          { key: "balance", label: "Balance", type: "money" }, { key: "held", label: "Held", type: "money" }, { key: "frozen", label: "Frozen", type: "bool", width: 8 },
          { key: "lastMovement", label: "Last movement", type: "datetime", width: 18 },
        ],
      };
    },
  },

  inventory_valuation: {
    key: "inventory_valuation", label: "Inventory valuation", category: "finance", finance: true, defaultRange: null,
    description: "Units on hand per SKU and warehouse at cost (stock cost, else product cost) and at retail.",
    async build() {
      const levels = await prisma.stockLevel.findMany({
        where: { onHand: { gt: 0 } }, take: MAX_ROWS,
        select: {
          onHand: true, reserved: true, cost: true, warehouse: { select: { code: true } },
          variant: { select: { sku: true, size: true, color: true, price: true, product: { select: { name: true, price: true, cost: true, brand: { select: { name: true } } } } } },
        },
        orderBy: [{ variant: { sku: "asc" } }],
      });
      const rows: Row[] = levels.map((l) => {
        const unitCost = l.cost ?? l.variant.product.cost ?? null;
        const price = l.variant.price ?? l.variant.product.price;
        return {
          sku: l.variant.sku, product: l.variant.product.name, brand: l.variant.product.brand.name, variant: [l.variant.color, l.variant.size].filter(Boolean).join(" · "),
          warehouse: l.warehouse.code, onHand: l.onHand, reserved: l.reserved, unitCost, value: unitCost === null ? null : unitCost * l.onHand, price, retailValue: price * l.onHand,
        };
      });
      return {
        title: "Inventory valuation", period: `As of ${dayKey()}`, rows, totals: totalsOf(rows, "Total", ["onHand", "reserved", "value", "retailValue"]),
        columns: [
          { key: "sku", label: "SKU", type: "text", width: 18 }, { key: "product", label: "Product", type: "text", width: 30 }, { key: "brand", label: "Brand", type: "text", width: 16 },
          { key: "variant", label: "Variant", type: "text", width: 12 }, { key: "warehouse", label: "Warehouse", type: "text", width: 10 },
          { key: "onHand", label: "On hand", type: "int" }, { key: "reserved", label: "Reserved", type: "int" },
          { key: "unitCost", label: "Unit cost", type: "money" }, { key: "value", label: "Value at cost", type: "money" },
          { key: "price", label: "Price", type: "money" }, { key: "retailValue", label: "Retail value", type: "money" },
        ],
      };
    },
  },

  concierge_pipeline: {
    key: "concierge_pipeline", label: "Concierge pipeline", category: "concierge", finance: false, defaultRange: "30d",
    description: "Concierge requests created in the period with status, priority, latest quote and amount paid.",
    async build(p) {
      const s = resolveSpan(p, "30d");
      const reqs = await prisma.conciergeRequest.findMany({
        where: { createdAt: { gte: s.start, lt: s.end } }, orderBy: { createdAt: "asc" }, take: MAX_ROWS,
        select: {
          number: true, createdAt: true, contactName: true, contactEmail: true, itemName: true, brand: true, category: true, priority: true, status: true, budget: true,
          quotes: { select: { number: true, total: true, amountPaid: true, status: true }, orderBy: { createdAt: "desc" } },
        },
      });
      const label = STATUS_LABELS.concierge.admin;
      const rows: Row[] = reqs.map((r) => ({
        number: r.number, createdAt: r.createdAt, customer: r.contactName, email: r.contactEmail, item: r.itemName, brand: r.brand, category: r.category,
        priority: r.priority, status: label[r.status] ?? r.status, budget: r.budget, quote: r.quotes[0]?.number ?? null, quoteTotal: r.quotes[0]?.total ?? null,
        quoteStatus: r.quotes[0]?.status ?? null, paid: r.quotes.reduce((n, q) => n + q.amountPaid, 0),
      }));
      return {
        title: "Concierge pipeline", period: s.label, rows, totals: totalsOf(rows, "Total", ["quoteTotal", "paid"]),
        columns: [
          { key: "number", label: "Request", type: "text", width: 16 }, { key: "createdAt", label: "Created", type: "datetime", width: 18 },
          { key: "customer", label: "Customer", type: "text", width: 20 }, { key: "email", label: "Email", type: "text", width: 26 },
          { key: "item", label: "Item", type: "text", width: 28 }, { key: "brand", label: "Brand", type: "text", width: 14 }, { key: "category", label: "Category", type: "text", width: 12 },
          { key: "priority", label: "Priority", type: "text", width: 9 }, { key: "status", label: "Status", type: "text", width: 14 }, { key: "budget", label: "Budget", type: "money" },
          { key: "quote", label: "Quote", type: "text", width: 16 }, { key: "quoteTotal", label: "Quote total", type: "money" }, { key: "quoteStatus", label: "Quote status", type: "text", width: 10 },
          { key: "paid", label: "Paid", type: "money" },
        ],
      };
    },
  },

  customer_list: {
    key: "customer_list", label: "Customer list", category: "customers", finance: false, defaultRange: null,
    description: "Every active customer with tier, orders, lifetime spend and marketing consent.",
    async build(p) {
      const span = p.range || p.from || p.to ? resolveSpan(p, "30d") : null;
      const customers = await prisma.customer.findMany({
        where: { deletedAt: null, ...(span ? { createdAt: { gte: span.start, lt: span.end } } : {}) }, orderBy: { createdAt: "asc" }, take: MAX_ROWS,
        select: { firstName: true, lastName: true, email: true, phone: true, country: true, tier: true, status: true, marketingOptIn: true, createdAt: true, stats: { select: { ordersCount: true, totalSpend: true, lastOrderAt: true } } },
      });
      const rows: Row[] = customers.map((c) => ({
        name: fullName(c), email: c.email, phone: c.phone, country: c.country, tier: c.tier, status: c.status, joined: c.createdAt,
        orders: c.stats?.ordersCount ?? 0, totalSpend: Number(c.stats?.totalSpend ?? 0), lastOrderAt: c.stats?.lastOrderAt ?? null, marketingOptIn: c.marketingOptIn,
      }));
      return {
        title: "Customer list", period: span?.label ?? `As of ${dayKey()}`, rows, totals: totalsOf(rows, "Total", ["orders", "totalSpend"]),
        columns: [
          { key: "name", label: "Name", type: "text", width: 22 }, { key: "email", label: "Email", type: "text", width: 28 }, { key: "phone", label: "Phone", type: "text", width: 16 },
          { key: "country", label: "Country", type: "text", width: 7 }, { key: "tier", label: "Tier", type: "text", width: 10 }, { key: "status", label: "Status", type: "text", width: 9 },
          { key: "joined", label: "Joined", type: "date", width: 12 }, { key: "orders", label: "Orders", type: "int" }, { key: "totalSpend", label: "Total spend", type: "money" },
          { key: "lastOrderAt", label: "Last order", type: "date", width: 12 }, { key: "marketingOptIn", label: "Marketing", type: "bool", width: 9 },
        ],
      };
    },
  },

  orders_export: {
    key: "orders_export", label: "Orders export", category: "sales", finance: false, defaultRange: "30d",
    description: "Orders placed in the period with status, payment and totals.",
    async build(p) {
      const s = resolveSpan(p, "30d");
      const orders = await prisma.order.findMany({
        where: { placedAt: { gte: s.start, lt: s.end } }, orderBy: { placedAt: "asc" }, take: MAX_ROWS,
        select: {
          number: true, placedAt: true, channel: true, status: true, paymentStatus: true, paymentMethod: true, deliveryMethod: true, contact: true, guestEmail: true,
          subtotal: true, discount: true, shipping: true, tax: true, total: true, amountPaid: true, amountRefunded: true, couponCode: true,
          customer: { select: { firstName: true, lastName: true, email: true } }, _count: { select: { items: true } },
        },
      });
      const label = STATUS_LABELS.order.admin;
      const rows: Row[] = orders.map((o) => {
        const c = (o.contact ?? {}) as { email?: string; name?: string };
        return {
          number: o.number, placedAt: o.placedAt, customer: o.customer ? fullName(o.customer) : (c.name ?? "Guest"), email: o.customer?.email ?? c.email ?? o.guestEmail ?? "",
          channel: o.channel, status: label[o.status] ?? o.status, payment: o.paymentStatus, method: o.paymentMethod, delivery: o.deliveryMethod, items: o._count.items,
          coupon: o.couponCode, subtotal: o.subtotal, discount: o.discount, shipping: o.shipping, tax: o.tax, total: o.total, paid: o.amountPaid, refunded: o.amountRefunded,
        };
      });
      return {
        title: "Orders export", period: s.label, rows,
        totals: totalsOf(rows, "Total", ["items", "subtotal", "discount", "shipping", "tax", "total", "paid", "refunded"]),
        columns: [
          { key: "number", label: "Order", type: "text", width: 16 }, { key: "placedAt", label: "Placed", type: "datetime", width: 18 },
          { key: "customer", label: "Customer", type: "text", width: 20 }, { key: "email", label: "Email", type: "text", width: 26 },
          { key: "channel", label: "Channel", type: "text", width: 9 }, { key: "status", label: "Status", type: "text", width: 16 }, { key: "payment", label: "Payment", type: "text", width: 12 },
          { key: "method", label: "Method", type: "text", width: 12 }, { key: "delivery", label: "Delivery", type: "text", width: 9 }, { key: "items", label: "Items", type: "int" },
          { key: "coupon", label: "Coupon", type: "text", width: 12 }, { key: "subtotal", label: "Subtotal", type: "money" }, { key: "discount", label: "Discount", type: "money" },
          { key: "shipping", label: "Shipping", type: "money" }, { key: "tax", label: "Tax added", type: "money" }, { key: "total", label: "Total", type: "money" },
          { key: "paid", label: "Paid", type: "money" }, { key: "refunded", label: "Refunded", type: "money" },
        ],
      };
    },
  },
};

export const generatorList = () =>
  Object.values(GENERATORS).map((g) => ({ key: g.key, label: g.label, description: g.description, category: g.category, finance: g.finance, defaultRange: g.defaultRange }));
