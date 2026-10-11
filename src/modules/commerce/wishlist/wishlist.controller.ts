import type { Ctx } from "@/core/http/router";
import { wishlistService as svc } from "./wishlist.service";
import type { WishlistItemBody, WishlistMergeBody } from "./wishlist.schemas";

export const wishlistController = {
  list: ({ customerId }: Ctx) => svc.list(customerId),
  ids: ({ customerId }: Ctx) => svc.ids(customerId),
  toggle: ({ customerId, body }: Ctx<WishlistItemBody>) => svc.toggle(customerId, body),
  remove: ({ customerId, params }: Ctx<unknown, unknown, { productId: string }>) => svc.remove(customerId, params.productId),
  merge: ({ customerId, body }: Ctx<WishlistMergeBody>) => svc.merge(customerId, body.items),
};
