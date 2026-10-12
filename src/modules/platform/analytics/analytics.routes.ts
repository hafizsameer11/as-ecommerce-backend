import { ModuleRouter } from "@/core/http/router";
import { publicLimiter } from "@/core/middleware/rate-limit";
import { analyticsController as c } from "./analytics.controller";
import { cohortsQuery, conciergeQuery, eventsBody, productsQuery, rebuildBody, salesQuery, trafficQuery } from "./analytics.schemas";

/** web / app behaviour events (anonymous allowed; send X-Anon-Id) */
export const eventsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/events", tag: "Analytics", defaultAuth: "optionalCustomer" })
  .post("/", {
    summary: "Record up to 50 events: page_view | product_view | add_to_cart | checkout_start | search",
    description:
      "Body `{ anonId?, sessionId?, events: [{ name, sessionId?, path?, productId?, query?, device?, channel?, utm?: { source, medium, campaign }, referrer?, country? }] }`. " +
      "The `X-Anon-Id` header wins over `anonId`. Invalid events are dropped (see `recorded`). Purchases are recorded by the server when an order is paid.",
    body: eventsBody, status: 202, middleware: [publicLimiter],
  }, c.ingest);

/** asl-admin /analytics/* */
export const analyticsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/analytics", tag: "Analytics", defaultAuth: "admin", defaultPermission: "analytics.view" })
  .get("/sales", { summary: "Sales: KPIs vs previous period, daily series, channel / country / category split, product table", query: salesQuery }, c.sales)
  .get("/products", { summary: "Products: revenue, units, views, conversion, margin, stock cover, searches", query: productsQuery }, c.products)
  .get("/traffic", { summary: "Traffic: visitors, sessions, sources, devices, pages, referrers, funnel", query: trafficQuery }, c.traffic)
  .get("/cohorts", { summary: "Monthly sign-up cohorts: retention / orders / revenue by month since sign-up", query: cohortsQuery }, c.cohorts)
  .get("/concierge", { summary: "Concierge: requests, quotes, conversion, time to quote, revenue, agents, suppliers", query: conciergeQuery }, c.concierge)
  .post("/rollups/rebuild", {
    summary: "Rebuild the daily rollups for a date range (Lagos days, inclusive)", body: rebuildBody,
    audit: { category: "system", action: "analytics.rollups_rebuilt", entity: "analytics" },
  }, c.rebuild);
