import type { Ctx } from "@/core/http/router";
import { searchService as svc } from "./search.service";
import type { SearchQuery, SuggestQuery } from "./search.schemas";

export const searchController = {
  search: ({ query, req }: Ctx<unknown, SearchQuery>) => svc.search(query, { customerId: req.customer?.id, anonId: req.anonId }),
  suggest: ({ query }: Ctx<unknown, SuggestQuery>) => svc.suggest(query.q),
  popular: () => svc.popular(),
};
