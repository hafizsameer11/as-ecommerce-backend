import { ModuleRouter } from "@/core/http/router";
import { authLimiter } from "@/core/middleware/rate-limit";
import { newsletterController as c } from "./newsletter.controller";
import { newsletterBody } from "./newsletter.schemas";

/** Storefront newsletter signup (footer form, checkout opt-in uses checkout session). */
export const newsletterStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/marketing", tag: "Marketing", defaultAuth: "optionalCustomer" })
  .post("/newsletter", {
    summary: "Subscribe to the newsletter",
    description:
      "Known customers get `marketingOptIn: true`. Guests are stored as newsletter leads. " +
      "Signed-in customers can omit `email` and use their account email via optional auth.",
    body: newsletterBody,
    status: 201,
    middleware: [authLimiter],
  }, c.subscribe);