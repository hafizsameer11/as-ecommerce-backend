import { z } from "zod";

export const wishlistItemBody = z.object({
  productId: z.string().min(1).max(64),
  size: z.string().max(40).nullable().optional(),
  color: z.string().max(60).nullable().optional(),
});
export const wishlistMergeBody = z.object({ items: z.array(wishlistItemBody).max(200) });
export type WishlistItemBody = z.infer<typeof wishlistItemBody>;
export type WishlistMergeBody = z.infer<typeof wishlistMergeBody>;
