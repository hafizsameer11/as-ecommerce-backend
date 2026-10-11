import { z } from "zod";

export const sizeGuideQuery = z.object({ brand: z.string().optional(), category: z.string().optional() });
export const sizeGuideBody = z.object({
  scope: z.enum(["brand", "category"]),
  target: z.string().min(1).max(80),
  note: z.string().min(1).max(2000),
  chartUrl: z.string().max(1024).nullable().optional(),
});

export type SizeGuideQuery = z.infer<typeof sizeGuideQuery>;
export type SizeGuideBody = z.infer<typeof sizeGuideBody>;
