import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { wishlistController as c } from "./wishlist.controller";

import { wishlistItemBody as item, wishlistMergeBody as mergeBody } from "./wishlist.schemas";

/** /wishlist, heart buttons on cards and product pages */
export const wishlistStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/wishlist", tag: "Wishlist", defaultAuth: "customer" })
  .get("/", { summary: "Saved items (product cards + on-sale count)" }, c.list)
  .get("/ids", { summary: "Saved product ids (to paint hearts)" }, c.ids)
  .post("/", { summary: "Toggle a product in the wishlist", body: item }, c.toggle)
  .post("/merge", { summary: "Save a guest's device wishlist to the account", body: mergeBody }, c.merge)
  .delete("/:productId", { summary: "Remove from wishlist", params: z.object({ productId: z.string().min(1).max(64) }) }, c.remove);
