import { z } from "zod";

export const globalSearchQuery = z.object({
  q: z.string().trim().min(2, "Type at least 2 characters").max(100),
  /** per group, default 5 */
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type GlobalSearchQuery = z.infer<typeof globalSearchQuery>;
