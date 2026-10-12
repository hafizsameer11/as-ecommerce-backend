import type { Ctx } from "@/core/http/router";
import { dashboardService as svc } from "./dashboard.service";
import type { DashboardQuery } from "./dashboard.schemas";

export const dashboardController = {
  get: ({ query }: Ctx<unknown, DashboardQuery>) => svc.get(query),
};
