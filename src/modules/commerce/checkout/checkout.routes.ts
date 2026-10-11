import { ModuleRouter } from "@/core/http/router";
import { checkoutController as c } from "./checkout.controller";
import { couponBody, placeOrderBody, updateCheckoutBody } from "./checkout.schemas";

/** /checkout (Information → Shipping → Payment → Review) on web and app */
export const checkoutStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/checkout", tag: "Checkout", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Resume checkout: bag, saved choices, delivery options, pick-up stores, totals" }, c.get)
  .patch("/", {
    summary: "Save any step (contact, delivery method, address, pick-up store, shipping rate, payment method, wallet, gift message) → new totals",
    body: updateCheckoutBody,
  }, c.update)
  .post("/coupon", { summary: "Apply a coupon code (errors explain why it can't be used)", body: couponBody }, c.applyCoupon)
  .delete("/coupon", { summary: "Remove the coupon" }, c.removeCoupon)
  .post("/place-order", {
    summary: "Place order → `{ order, payment }`. Open `payment.authorizationUrl` to pay; `payment` is null when the wallet covered it.",
    body: placeOrderBody, status: 201, idempotent: "checkout.place-order",
  }, c.placeOrder);
