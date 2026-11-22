import { ModuleRouter, idParam } from "@/core/http/router";
import { cartController as c } from "./cart.controller";
import { removeItemBody, updateItemBody } from "./cart.schemas";

/** /concierge/cart edits (GET /concierge/cart is in ../requests) */
export const conciergeCartStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge", tag: "Concierge", defaultAuth: "customer" })
  .patch("/cart/items/:id", {
    summary: "Change qty / size / colour / notes of a cart item (request id or ASL number)",
    description: "Allowed until something is paid. If a quote was already sent it is withdrawn and the request goes back to sourcing (`quoteWithdrawn`).",
    params: idParam,
    body: updateItemBody,
  }, c.updateItem)
  .delete("/cart/items/:id", {
    summary: "Remove a cart item = cancel the request (before payment). Closed requests: no-op.",
    params: idParam,
    body: removeItemBody,
  }, c.removeItem)
  .post("/cart/clear", { summary: "Clear cart: cancel every unpaid item; paid items are kept with the reason" }, c.clear);