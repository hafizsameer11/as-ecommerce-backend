import { ModuleRouter } from "@/core/http/router";
import { searchController as c } from "./search.controller";
import { searchQuery, suggestQuery } from "./search.schemas";

/** /search screen */
export const searchStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/search", tag: "Search", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Search products, brands and categories", query: searchQuery }, c.search)
  .get("/suggest", { summary: "Type-ahead suggestions", query: suggestQuery }, c.suggest)
  .get("/popular", { summary: "Popular searches (from real search logs, falls back to curated list)" }, c.popular);
