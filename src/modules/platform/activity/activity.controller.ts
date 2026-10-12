import { withMeta, type Ctx } from "@/core/http/router";
import { activityService as svc } from "./activity.service";
import type { ActivityFilters } from "./activity.schemas";

export const activityController = {
  list: async ({ query, admin }: Ctx<unknown, ActivityFilters>) => {
    const r = await svc.list(query, admin.permissions);
    return withMeta(r.items, r.meta);
  },
};
