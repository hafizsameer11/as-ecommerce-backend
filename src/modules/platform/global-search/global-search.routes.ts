import { ModuleRouter } from "@/core/http/router";
import { globalSearchController as c } from "./global-search.controller";
import { globalSearchQuery } from "./global-search.schemas";

/** asl-admin ⌘K command palette (any admin; each group needs its view permission) */
export const globalSearchAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/search", tag: "Global search", defaultAuth: "admin" })
  .get("/global", {
    summary: "Search orders, customers, products, concierge requests and tickets",
    description:
      "q ≥ 2 chars. Top 5 per group, newest first, each with an admin-app `link`. Groups need orders.view / customers.view / catalog.view / " +
      "concierge.view / support.tickets; empty groups are omitted.",
    query: globalSearchQuery,
  }, c.search);
