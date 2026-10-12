import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";
import { rollupsService } from "@/modules/platform/analytics/analytics.rollups";
import { addDays, dayKey, dbDate, dayStart } from "@/modules/platform/analytics/analytics.dates";
import { reportsService } from "@/modules/platform/reports/reports.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;
let marketing: string; // analytics.view, no finance.view
let support: string; // no analytics.view
let buyer: Awaited<ReturnType<typeof registerCustomer>>;
let product: { handle: string; productId: string; size: string | null; color: string | null; price: number };
let order: { id: string; number: string; total: number };
const today = dayKey();

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

const binary = (res: any, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

const send = (anon: string | null, body: Record<string, unknown>, token?: string) => {
  const r = api().post(`${S}/events`);
  if (anon) r.set("X-Anon-Id", anon);
  if (token) r.set(bearer(token));
  return r.send(body);
};

async function pickProduct() {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: N(20_000), lte: N(140_000) } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= 3);
    if (v) return { handle: p.handle, productId: p.id, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error("no product");
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  marketing = (await createAdmin("marketing")).token;
  support = (await createAdmin("support")).token;
  product = await pickProduct();
}, 240_000);

describe("POST /store/events", () => {
  it("records valid events, drops junk, never trusts client money", async () => {
    const r = await send("anon-aaaa-1111", {
      sessionId: "sess-a-1",
      events: [
        { name: "page_view", path: "/", utm: { source: "google", medium: "cpc", campaign: "brand" }, device: "desktop" },
        { name: "product_view", productId: product.handle, path: `/product/${product.handle}` },
        { name: "add_to_cart", productId: product.productId },
        { name: "search", query: "Jordan 1" },
        { name: "purchase", value: 999_999_999 }, // server-only
        { name: "product_view", productId: "no-such-product" },
        { name: "page_view", device: "fridge" },
        "junk",
      ],
    });
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ received: 8, recorded: 4 });
    const rows = await prisma.analyticsEvent.findMany({ where: { anonId: "anon-aaaa-1111" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((e) => e.name).sort()).toEqual(["add_to_cart", "page_view", "product_view", "search"]);
    expect(rows.every((e) => e.value === null)).toBe(true);
    expect(rows.every((e) => e.source === "paid")).toBe(true); // the visit keeps its source
    expect(rows.find((e) => e.name === "product_view")!.productId).toBe(product.productId);
    expect(rows.find((e) => e.name === "search")!.path).toBe("/search?q=jordan%201");

    // later page view in the same visit without UTM → still "paid"
    await send("anon-aaaa-1111", { sessionId: "sess-a-1", events: [{ name: "page_view", path: "/shop" }] });
    expect((await prisma.analyticsEvent.findFirst({ where: { anonId: "anon-aaaa-1111", path: "/shop" } }))!.source).toBe("paid");
  });

  it("classifies referrers and devices; needs an anonymous id; caps the batch at 50", async () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
    const r = await api().post(`${S}/events`).set("X-Anon-Id", "anon-bbbb-2222").set("User-Agent", ua)
      .send({ sessionId: "sess-b-1", events: [{ name: "page_view", path: "/", referrer: "https://l.instagram.com/x" }, { name: "page_view", path: "/shop/footwear" }] });
    expect(r.body.data.recorded).toBe(2);
    await send("anon-bbbb-2222", { sessionId: "sess-b-2", events: [{ name: "page_view", path: "/", device: "mobile" }] });
    const b = await prisma.analyticsEvent.findMany({ where: { anonId: "anon-bbbb-2222" } });
    expect(b.filter((e) => e.sessionId === "sess-b-1").every((e) => e.source === "social" && e.device === "mobile")).toBe(true);
    expect(b.find((e) => e.sessionId === "sess-b-2")!.source).toBe("direct");

    const noId = await send(null, { events: [{ name: "page_view", path: "/" }] });
    expect(noId.body.data.recorded).toBe(0);
    const big = await send("anon-bbbb-2222", { events: Array.from({ length: 51 }, () => ({ name: "page_view" })) });
    expect(big.status).toBe(400);
  });
});

describe("order → rollups → dashboard", () => {
  it("a paid order becomes a server-side purchase event attributed to the buyer's visit", async () => {
    buyer = await registerCustomer();
    await send("anon-cccc-3333", { sessionId: "sess-c-1", events: [
      { name: "page_view", path: "/", referrer: "https://www.google.com/" },
      { name: "product_view", productId: product.handle },
      { name: "add_to_cart", productId: product.handle },
      { name: "checkout_start" },
    ] }, buyer.token);

    expect((await api().post(`${S}/cart/items`).set(bearer(buyer.token)).send({ productId: product.handle, size: product.size, color: product.color, qty: 1 })).status).toBe(201);
    await api().patch(`${S}/checkout`).set(bearer(buyer.token)).send({ contact: { email: buyer.email, phone: "+2348012345678" }, delivery: "ship", address: lagos });
    const placed = await api().post(`${S}/checkout/place-order`).set(bearer(buyer.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(placed.status).toBe(201);
    const pay = await api().post(`${W}/mock/checkout/${placed.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
    expect(pay.status).toBe(200);
    await settle();
    const o = await prisma.order.findUniqueOrThrow({ where: { id: placed.body.data.order.id } });
    expect(o.paidAt).not.toBeNull();
    order = { id: o.id, number: o.number, total: o.total };

    const purchase = await prisma.analyticsEvent.findFirstOrThrow({ where: { name: "purchase" } });
    expect(purchase.value).toBe(o.total);
    expect(purchase.anonId).toBe("anon-cccc-3333");
    expect(purchase.sessionId).toBe("sess-c-1");
    expect(purchase.source).toBe("organic");
  });

  it("rolls up a day idempotently (sales, products, traffic)", async () => {
    // a visit by A yesterday: distinct visitors over the range must not double count A
    await prisma.analyticsEvent.create({
      data: { anonId: "anon-aaaa-1111", sessionId: "sess-a-0", name: "page_view", path: "/", device: "desktop", source: "direct", createdAt: new Date(dayStart(today).getTime() - 3_600_000) },
    });
    await rollupsService.rebuildRange(addDays(today, -1), today);
    await rollupsService.rebuildRange(addDays(today, -1), today); // same result twice

    const sales = await prisma.dailySales.findMany({ where: { date: dbDate(today) } });
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ channel: "web", country: "NG", orders: 1, units: 1 });
    expect(Number(sales[0].revenue)).toBe(order.total);
    expect(Number(sales[0].refunds)).toBe(0);

    const ps = await prisma.dailyProductStats.findUniqueOrThrow({ where: { date_productId: { date: dbDate(today), productId: product.productId } } });
    expect(ps).toMatchObject({ views: 2, addToCart: 2, units: 1 });
    expect(Number(ps.revenue)).toBe(product.price);

    const traffic = await prisma.dailyTraffic.findMany({ where: { date: dbDate(today) } });
    const cell = (source: string, device: string) => traffic.find((t) => t.source === source && t.device === device);
    expect(cell("all", "all")).toMatchObject({ visitors: 3, orders: 1 }); // A, B, C (the purchase adds no visitor)
    expect(cell("all", "mobile")!.visitors).toBe(1); // B, although B came twice from two sources
    expect(cell("social", "mobile")!.visitors + cell("direct", "mobile")!.visitors).toBe(2);
    expect(cell("organic", "all")!.orders).toBe(1);
    expect(cell("paid", "all")!.visitors).toBe(1);
    const y = await prisma.dailyTraffic.findFirstOrThrow({ where: { date: dbDate(addDays(today, -1)), source: "all", device: "all" } });
    expect(y.visitors).toBe(1);
  });

  it("dashboard: KPIs vs previous period, series, top products, recent orders, pipeline, low stock", async () => {
    // a closed day in the previous 7-day period, straight into the rollup table
    await prisma.dailySales.create({ data: { date: dbDate(addDays(today, -9)), channel: "web", country: "NG", revenue: BigInt(N(100_000)), orders: 2, refunds: 0n, discounts: 0n, units: 2 } });

    const r = await api().get(`${A}/dashboard?range=7d`).set(bearer(admin));
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.kpis.revenue.value).toBe(order.total);
    expect(d.kpis.revenue.previous).toBe(N(100_000));
    expect(d.kpis.revenue.delta).toBeCloseTo((order.total - N(100_000)) / N(100_000), 3);
    expect(d.kpis.orders).toMatchObject({ value: 1, previous: 2 });
    expect(d.kpis.aov.value).toBe(order.total);
    expect(d.kpis.newCustomers.value).toBeGreaterThanOrEqual(1);
    expect(d.kpis.conversion.value).toBeGreaterThan(0);
    expect(d.series).toHaveLength(7);
    expect(d.series.at(-1)).toEqual({ date: today, revenue: order.total, orders: 1 });
    expect(d.series.reduce((n: number, s: any) => n + s.revenue, 0)).toBe(order.total);
    expect(d.topProducts[0]).toMatchObject({ id: product.productId, units: 1, revenue: product.price });
    expect(d.recentOrders[0]).toMatchObject({ number: order.number, total: order.total, statusLabel: "Unfulfilled" });
    expect(d.recentOrders[0].customer.email).toBe(buyer.email);
    expect(d.concierge.byStatus.map((s: any) => s.status)).toContain("quoted");
    expect(Array.isArray(d.lowStock)).toBe(true);

    expect((await api().get(`${A}/dashboard?range=1y`).set(bearer(admin))).status).toBe(400);
  });

  it("refunds show up on the day the money went back", async () => {
    const refund = await api().post(`${A}/orders/${order.id}/refund`).set(bearer(admin)).send({ amount: N(5_000), reason: "Goodwill" });
    expect(refund.status).toBe(200);
    await settle();
    await rollupsService.rebuildDay(today);
    const sales = await prisma.dailySales.findFirstOrThrow({ where: { date: dbDate(today) } });
    expect(Number(sales.refunds)).toBe(N(5_000));
    const ps = await prisma.dailyProductStats.findUniqueOrThrow({ where: { date_productId: { date: dbDate(today), productId: product.productId } } });
    expect(Number(ps.refunds)).toBe(N(5_000));

    const s = (await api().get(`${A}/analytics/sales?range=7d`).set(bearer(admin))).body.data;
    expect(s.kpis.refunds.value).toBe(N(5_000));
    expect(s.kpis.net.value).toBe(order.total - N(5_000));
    expect(s.channels.find((c: any) => c.channel === "web")).toMatchObject({ revenue: order.total, orders: 1, share: 1 });
    expect(s.countries[0]).toMatchObject({ country: "NG", revenue: order.total });
    expect(s.products[0]).toMatchObject({ id: product.productId, units: 1, revenue: product.price });
    expect(s.series.at(-1)).toMatchObject({ date: today, revenue: order.total, refunds: N(5_000), visitors: 3 });
    // filters
    expect((await api().get(`${A}/analytics/sales?range=7d&channel=mobile`).set(bearer(admin))).body.data.kpis.revenue.value).toBe(0);
    expect((await api().get(`${A}/analytics/sales?range=7d&country=gb`).set(bearer(admin))).body.data.kpis.revenue.value).toBe(0);
  });
});

describe("analytics screens", () => {
  it("traffic: distinct visitors over the range, sources, devices, funnel, filters", async () => {
    const t = (await api().get(`${A}/analytics/traffic?range=7d`).set(bearer(admin))).body.data;
    expect(t.totalVisitors).toBe(3); // A counted once although seen on two days
    expect(t.series.reduce((n: number, p: any) => n + p.visitors, 0)).toBe(4); // daily uniques
    expect(t.sources.find((s: any) => s.source === "paid").visitors).toBe(1);
    expect(t.sources.find((s: any) => s.source === "social").visitors).toBe(1);
    expect(t.sources.find((s: any) => s.source === "organic")).toMatchObject({ visitors: 1, orders: 1 });
    expect(t.devices.find((d: any) => d.device === "mobile").visitors).toBe(1); // B (two visits)
    expect(t.funnel.map((f: any) => f.value)).toEqual([3, 2, 2, 1, 1]);
    expect(t.pages[0].path).toBe("/");
    expect(t.referrers.map((r: any) => r.host)).toEqual(expect.arrayContaining(["l.instagram.com", "google.com"]));
    expect(t.bounceRate).toBeGreaterThan(0);

    const mobile = (await api().get(`${A}/analytics/traffic?range=7d&device=mobile`).set(bearer(admin))).body.data;
    expect(mobile.totalVisitors).toBe(1);
    const social = (await api().get(`${A}/analytics/traffic?range=7d&source=social`).set(bearer(admin))).body.data;
    expect(social.totalVisitors).toBe(1);
    expect(social.totalSessions).toBe(1);
  });

  it("products: revenue, views, conversion, margin, searches", async () => {
    const r = await api().get(`${A}/analytics/products?range=7d&sort=revenue`).set(bearer(admin));
    expect(r.status).toBe(200);
    const p = r.body.data;
    expect(p.rows[0]).toMatchObject({ id: product.productId, units: 1, revenue: product.price, views: 2, addToCart: 2, conv: 0.5 });
    expect(p.totalRevenue).toBe(product.price);
    expect(p.pagination.total).toBeGreaterThan(1);
    expect(p.categories[0].revenue).toBe(product.price);
    expect(p.topSearches).toEqual([]); // only the search endpoint writes SearchLog
    const views = (await api().get(`${A}/analytics/products?range=7d&sort=views&pageSize=5`).set(bearer(admin))).body.data;
    expect(views.rows).toHaveLength(5);
    expect(views.rows[0].views).toBe(2);
  });

  it("cohorts: monthly sign-up cohorts × months since sign-up", async () => {
    const r = (await api().get(`${A}/analytics/cohorts?window=6m&metric=retention`).set(bearer(admin))).body.data;
    expect(r.size).toBe(6);
    expect(r.cohorts).toHaveLength(6);
    const last = r.cohorts.at(-1);
    expect(last.month).toBe(today.slice(0, 7));
    expect(last.row).toHaveLength(6);
    expect(last.row.slice(1).every((v: number | null) => v === null)).toBe(true);
    expect(last.row[0]).toBeCloseTo(1 / last.newCustomers, 4);
    expect(r.segments.map((s: any) => s.name)).toEqual(["First-time buyers", "Repeat customers", "ASL Club members", "VIP concierge"]);
    const rev = (await api().get(`${A}/analytics/cohorts?window=12m&metric=revenue`).set(bearer(admin))).body.data;
    expect(rev.cohorts).toHaveLength(12);
    expect(rev.cohorts.at(-1).row[0]).toBe(order.total);
    expect(rev.ltv[0].ltv).toBeGreaterThan(0);
  });

  it("concierge: shape", async () => {
    const r = await api().get(`${A}/analytics/concierge?range=30d&priority=vip`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ totalRequests: expect.any(Number), conversion: expect.any(Number), gmv: expect.any(Number) });
    expect(r.body.data.stages).toHaveLength(5);
    expect(r.body.data.series).toHaveLength(30);
  });

  it("needs analytics.view", async () => {
    for (const p of ["/dashboard", "/analytics/sales", "/analytics/traffic", "/analytics/products", "/analytics/cohorts", "/analytics/concierge", "/reports"]) {
      expect((await api().get(`${A}${p}`).set(bearer(support))).status).toBe(403);
    }
    expect((await api().get(`${A}/dashboard`)).status).toBe(401);
    expect((await api().get(`${A}/dashboard`).set(bearer(marketing))).status).toBe(200);
  });
});

describe("reports", () => {
  let salesReport: string;

  it("library starts with the default reports; finance ones hidden without finance.view", async () => {
    const all = await api().get(`${A}/reports`).set(bearer(admin));
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(8);
    expect(all.body.meta.kpis.library).toBe(8);
    const gens = (await api().get(`${A}/reports/generators`).set(bearer(marketing))).body.data;
    expect(gens.find((g: any) => g.key === "vat_report")).toMatchObject({ finance: true, allowed: false });
    const mine = await api().get(`${A}/reports`).set(bearer(marketing));
    expect(mine.body.data.map((r: any) => r.generator)).not.toContain("vat_report");
    expect(mine.body.meta.total).toBe(5);
  });

  it("CRUD, favorite, finance permission", async () => {
    const c = await api().post(`${A}/reports`).set(bearer(admin)).send({ name: "Weekly sales", generator: "sales_summary", params: { range: "7d" }, formats: ["csv", "xlsx"] });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ category: "sales", schedule: "off", nextRunAt: null, favorite: false });
    salesReport = c.body.data.id;
    expect((await api().post(`${A}/reports/${salesReport}/favorite`).set(bearer(admin))).body.data.favorite).toBe(true);
    const upd = await api().patch(`${A}/reports/${salesReport}`).set(bearer(admin)).send({ description: "Last 7 days" });
    expect(upd.body.data).toMatchObject({ description: "Last 7 days", favorite: true, formats: ["csv", "xlsx"] });

    const denied = await api().post(`${A}/reports`).set(bearer(marketing)).send({ name: "VAT", generator: "vat_report" });
    expect(denied.status).toBe(403);
    const vat = await prisma.savedReport.findFirstOrThrow({ where: { generator: "vat_report" } });
    expect((await api().post(`${A}/reports/${vat.id}/run`).set(bearer(marketing)).send({ format: "csv" })).status).toBe(403);
    expect((await api().get(`${A}/reports/${vat.id}`).set(bearer(marketing))).status).toBe(403);
    expect((await api().post(`${A}/reports/${salesReport}/run`).set(bearer(support)).send({ format: "csv" })).status).toBe(403);

    const tmp = await api().post(`${A}/reports`).set(bearer(admin)).send({ name: "Temp", generator: "customer_list" });
    expect((await api().delete(`${A}/reports/${tmp.body.data.id}`).set(bearer(admin))).status).toBe(200);
    expect((await api().get(`${A}/reports/${tmp.body.data.id}`).set(bearer(admin))).status).toBe(404);
    expect(await prisma.auditEvent.count({ where: { action: { in: ["report.created", "report.deleted"] } } })).toBeGreaterThanOrEqual(2);
  });

  it("runs a CSV in the background and streams the file (not public)", async () => {
    const run = await api().post(`${A}/reports/${salesReport}/run`).set(bearer(admin)).send({ format: "csv" });
    expect(run.status).toBe(202);
    expect(run.body.data.status).toBe("queued");
    await settle();
    const done = (await api().get(`${A}/reports/runs/${run.body.data.id}`).set(bearer(admin))).body.data;
    expect(done).toMatchObject({ status: "ready", format: "csv", rows: 1 });
    expect(done.sizeBytes).toBeGreaterThan(0);

    const dl = await api().get(`${A}/reports/runs/${run.body.data.id}/download`).set(bearer(admin));
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toMatch(/text\/csv/);
    expect(dl.headers["content-disposition"]).toMatch(/weekly-sales-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = dl.text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Date,Channel,Orders,Units,Gross (NGN),Discounts (NGN),Refunds (NGN),Net (NGN),AOV (NGN)");
    expect(lines[1].split(",").slice(0, 5)).toEqual([today, "web", "1", "1", String(order.total / 100)]);
    expect(lines.at(-1)!.startsWith("Total,")).toBe(true);

    // stored outside the public uploads folder
    const r = await prisma.reportRun.findUniqueOrThrow({ where: { id: run.body.data.id } });
    expect(fs.existsSync(path.resolve(process.env.UPLOAD_DIR!, r.fileKey!))).toBe(false);
    expect((await api().get(`/uploads/${r.fileKey}`)).status).not.toBe(200);
    expect((await api().get(`${A}/reports/runs/${run.body.data.id}/download`)).status).toBe(401);

    const list = await api().get(`${A}/reports/runs?reportId=${salesReport}`).set(bearer(admin));
    expect(list.body.data[0]).toMatchObject({ id: run.body.data.id, reportName: "Weekly sales", status: "ready" });
    const lib = (await api().get(`${A}/reports/${salesReport}`).set(bearer(admin))).body.data;
    expect(lib).toMatchObject({ lastStatus: "ready", rowsLastRun: 1 });
    const csv = await api().get(`${A}/reports/runs/export`).set(bearer(admin));
    expect(csv.text).toContain("Weekly sales");
  });

  it("runs an XLSX orders export and a PDF VAT report", async () => {
    const orders = await prisma.savedReport.findFirstOrThrow({ where: { generator: "orders_export" } });
    const run = await api().post(`${A}/reports/${orders.id}/run`).set(bearer(admin)).send({ format: "xlsx" });
    await settle();
    const dl = await api().get(`${A}/reports/runs/${run.body.data.id}/download`).set(bearer(admin)).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe("Order");
    expect(ws.getRow(2).getCell(1).value).toBe(order.number);
    const totalCol = (ws.getRow(1).values as unknown[]).indexOf("Total (NGN)");
    expect(ws.getRow(2).getCell(totalCol).value).toBe(order.total / 100);

    const vat = await prisma.savedReport.findFirstOrThrow({ where: { generator: "vat_report" } });
    await prisma.savedReport.update({ where: { id: vat.id }, data: { params: { range: "7d" } } });
    const pr = await api().post(`${A}/reports/${vat.id}/run`).set(bearer(admin)).send({ format: "pdf" });
    await settle();
    const pdf = await api().get(`${A}/reports/runs/${pr.body.data.id}/download`).set(bearer(admin)).buffer(true).parse(binary);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await prisma.reportRun.findUniqueOrThrow({ where: { id: pr.body.data.id } })).rows).toBe(1);
    // finance file: download needs finance.view too
    expect((await api().get(`${A}/reports/runs/${pr.body.data.id}/download`).set(bearer(marketing))).status).toBe(403);
    expect((await api().get(`${A}/reports/runs`).set(bearer(marketing))).body.data.map((r: any) => r.generator)).not.toContain("vat_report");
  });

  it("scheduled reports email their files to the recipients", async () => {
    const bad = await api().post(`${A}/reports/${salesReport}/schedule`).set(bearer(admin)).send({ schedule: "weekly", recipients: [] });
    expect(bad.status).toBe(400);
    const s = await api().post(`${A}/reports/${salesReport}/schedule`).set(bearer(admin)).send({ schedule: "daily", recipients: ["Finance@ASL.dev", "ceo@asl.dev"] });
    expect(s.status).toBe(200);
    expect(s.body.data.recipients).toEqual(["finance@asl.dev", "ceo@asl.dev"]);
    const next = new Date(s.body.data.nextRunAt);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(new Date(next.getTime() + 3_600_000).getUTCHours()).toBe(7); // 07:00 Lagos

    // not due yet → nothing happens
    expect((await reportsService.runScheduled()).sent).toBe(0);
    await prisma.savedReport.update({ where: { id: salesReport }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    const before = mail.outbox!.length;
    const r = await reportsService.runScheduled();
    expect(r).toEqual({ due: 1, sent: 2 });
    const sent = mail.outbox!.slice(before).filter((m) => m.to === "finance@asl.dev");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Weekly sales");
    expect(sent[0].attachments!.map((a) => a.filename.split(".").pop()).sort()).toEqual(["csv", "xlsx"]);
    expect(sent[0].attachments![0].content.length).toBeGreaterThan(0);
    const after = await prisma.savedReport.findUniqueOrThrow({ where: { id: salesReport } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.reportRun.count({ where: { reportId: salesReport, requestedBy: "scheduler", status: "ready" } })).toBe(2);
    // a second pass finds nothing due
    expect((await reportsService.runScheduled()).due).toBe(0);

    const off = await api().post(`${A}/reports/${salesReport}/schedule`).set(bearer(admin)).send({ schedule: "off" });
    expect(off.body.data.nextRunAt).toBeNull();
  });
});
