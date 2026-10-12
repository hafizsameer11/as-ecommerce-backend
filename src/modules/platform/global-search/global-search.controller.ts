import type { Ctx } from "@/core/http/router";
import { globalSearchService as svc } from "./global-search.service";
import type { GlobalSearchQuery } from "./global-search.schemas";

export const globalSearchController = {
  search: ({ query, admin }: Ctx<unknown, GlobalSearchQuery>) => svc.search(query, admin.permissions),
};
