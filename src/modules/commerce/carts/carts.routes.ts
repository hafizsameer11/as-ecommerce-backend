import { ModuleRouter, idParam } from "@/core/http/router";
import { cartsController as c } from "./carts.controller";
import { addItemBody, mergeBody, updateItemBody } from "./carts.schemas";

const guestNote = "Guests: send the `X-Cart-Token` header returned as `guestToken` by the first add. Signed-in customers need no token.";

/** asl-web / asl-mobile: bag, quick-add, product "Add to bag", cart size picker */
export const cartsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/cart", tag: "Cart", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Get the bag (live prices, stock issues, free-shipping progress)", description: guestNote }, c.get)
  .get("/summary", { summary: "Header bag badge count" }, c.summary)
  .post("/items", { summary: "Add to bag", body: addItemBody, status: 201, description: guestNote }, c.add)
  .patch("/items/:id", { summary: "Change quantity / size of a line", params: idParam, body: updateItemBody }, c.update)
  .delete("/items/:id", { summary: "Remove a line", params: idParam }, c.remove)
  .delete("/", { summary: "Empty the bag" }, c.clear)
  .post("/remove-unavailable", { summary: "Remove sold-out / unavailable lines" }, c.removeUnavailable)
  .post("/merge", { summary: "After sign-in: merge the guest bag into the account bag", auth: "customer", body: mergeBody }, c.merge);
