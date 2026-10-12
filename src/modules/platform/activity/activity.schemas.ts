import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** `type` takes one key or a comma list (`order.placed,order.paid`), or a prefix like `order.*` */
export const activityFilters = pageQuery.extend({
  type: z.string().trim().max(300).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** dashboard ticker polling: only entries created after this instant */
  since: z.coerce.date().optional(),
});

export type ActivityFilters = z.infer<typeof activityFilters>;
