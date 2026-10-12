import { ModuleRouter } from "@/core/http/router";
import { dashboardController as c } from "./dashboard.controller";
import { dashboardQuery } from "./dashboard.schemas";

/** asl-admin "/" */
export const dashboardAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/dashboard", tag: "Dashboard", defaultAuth: "admin", defaultPermission: "analytics.view" })
  .get("/", {
    summary: "KPIs vs previous period, revenue series, top products / categories, orders by status, recent orders, concierge pipeline, low stock",
    query: dashboardQuery,
  }, c.get);
