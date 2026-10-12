import { z } from "zod";

export const dashboardQuery = z.object({
  range: z.enum(["7d", "14d", "30d", "90d"]).default("14d"),
});
export type DashboardQuery = z.infer<typeof dashboardQuery>;
