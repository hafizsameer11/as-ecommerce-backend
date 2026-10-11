import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { paymentMethodsController as c } from "./payment-methods.controller";

/** /account/payment-methods */
export const paymentMethodsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/payment-methods", tag: "Payment methods", defaultAuth: "customer" })
  .get("/", { summary: "Saved cards" }, c.list)
  .post("/", {
    summary: "Add a card → open `authorizationUrl` (₦50 check, refunded)",
    body: z.object({ returnUrl: z.string().url().max(500).nullable().optional() }), idempotent: "payment-method.add",
  }, c.add)
  .patch("/:id", { summary: "Rename / set default", params: idParam, body: z.object({ nickname: z.string().trim().max(40).nullable().optional(), isDefault: z.boolean().optional() }) }, c.update)
  .delete("/:id", { summary: "Remove card", params: idParam }, c.remove);
