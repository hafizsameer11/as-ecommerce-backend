import { ModuleRouter, idParam } from "@/core/http/router";
import { cartController as c } from "./cart.controller";
import { checkoutBody, checkoutPreviewQuery, removeItemBody, updateItemBody } from "./cart.schemas";

/** /concierge/cart edits + /concierge/payment (GET /concierge/cart itself is in ../requests) */
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
  .post("/cart/clear", { summary: "Clear cart: cancel every unpaid item; paid items are kept with the reason" }, c.clear)
  .get("/checkout", { summary: "Payment summary: payable items (deposit or balance due) + total; items not payable yet with the reason", query: checkoutPreviewQuery }, c.preview)
  .post("/checkout", {
    summary: "Accept and pay several quoted items in ONE payment → `{ checkout, payment }` (open payment.authorizationUrl)",
    description: "`requestIds` default to every payable cart item. 409 `QUOTE_EXPIRED` / `INVALID_STATE` lists the items that can't be paid.",
    body: checkoutBody,
    idempotent: "concierge.checkout",
  }, c.checkout)
  .get("/checkout/:id", { summary: "Checkout result for /concierge/success (payment status + requests)", params: idParam }, c.getCheckout);
