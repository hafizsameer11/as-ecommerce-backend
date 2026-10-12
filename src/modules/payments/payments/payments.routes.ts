import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { pageQuery } from "@/core/http/pagination";
import { paymentsController as c } from "./payments.controller";

const refParam = z.object({ reference: z.string().min(6).max(190) });

/** apps: after returning from the payment page */
export const paymentsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/payments", tag: "Payments", defaultAuth: "optionalCustomer" })
  .get("/:reference", { summary: "Payment status (poll while the webhook is on its way)", params: refParam }, c.status)
  .post("/:reference/verify", { summary: "Confirm with the gateway now (call on return from the payment page)", params: refParam }, c.verify);

/** gateway → us. Signature-checked, deduplicated. */
export const paymentWebhookRoutes = new ModuleRouter({ surface: "webhooks", prefix: "/payments", tag: "Webhooks" })
  .post("/:provider", { summary: "Payment gateway webhook", params: z.object({ provider: z.string().max(30) }), body: z.any() }, c.webhook)
  // mock gateway pages (404 in production)
  .get("/mock/checkout/:reference", { summary: "Mock payment page (dev only)", params: refParam }, c.mockPage)
  .post("/mock/checkout/:reference/complete", { summary: "Mock payment result (dev only)", params: refParam, body: z.object({ outcome: z.enum(["success", "failed"]) }) }, c.mockComplete);

/** asl-admin Transactions */
export const paymentsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/transactions", tag: "Transactions", defaultAuth: "admin", defaultPermission: "finance.view" })
  .get("/", {
    summary: "Payments and refunds",
    query: pageQuery.extend({
      status: z.enum(["pending", "succeeded", "failed", "abandoned", "refunded", "partially_refunded"]).optional(),
      purpose: z.enum(["order", "order_balance", "reservation_deposit", "wallet_topup", "concierge", "draft_order", "card_authorization"]).optional(),
    }),
  }, c.adminList)
  .post("/refunds/:id/retry", {
    summary: "Retry a failed refund: to the original payment again, or into the customer's ASL Wallet",
    description: "Refunds stay `pending` until the provider confirms (`refund.processed`); `failed` ones are still owed and flagged to finance.",
    permission: "finance.payouts",
    params: idParam,
    body: z.object({ to: z.enum(["original", "wallet"]).default("original") }),
    audit: { category: "finance", action: "refund.retried", entity: "refund" },
  }, c.retryRefund);
