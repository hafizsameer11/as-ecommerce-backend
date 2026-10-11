import { z } from "zod";

export const categoryStatus = z.enum(["active", "hidden", "draft"]);

export const nameBody = z.object({ name: z.string().trim().min(1).max(80) });
export const categoryPatch = z.object({
  name: z.string().min(1).max(80).optional(), handle: z.string().max(80).optional(), description: z.string().max(2000).nullable().optional(),
  image: z.string().max(1024).nullable().optional(), icon: z.string().max(60).nullable().optional(), featured: z.boolean().optional(),
  status: categoryStatus.optional(), concierge: z.boolean().optional(), seoTitle: z.string().max(190).nullable().optional(), seoDescription: z.string().max(500).nullable().optional(),
});
export const moveBody = z.object({ dir: z.enum(["up", "down"]) });
export const subParams = z.object({ id: z.string(), subId: z.string() });
export const subcategoryPatch = z.object({ name: z.string().min(1).max(80).optional(), status: categoryStatus.optional(), image: z.string().max(1024).nullable().optional() });

export type NameBody = z.infer<typeof nameBody>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type MoveBody = z.infer<typeof moveBody>;
export type SubParams = z.infer<typeof subParams>;
export type SubcategoryPatch = z.infer<typeof subcategoryPatch>;
