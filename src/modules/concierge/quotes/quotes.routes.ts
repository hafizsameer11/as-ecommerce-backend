import { ModuleRouter, idParam } from "@/core/http/router";
import { quotesController as c } from "./quotes.controller";
import { acceptBody, adminQuotesQuery, createQuoteBody, declineBody, payBalanceBody, refundBody, reviseQuoteBody, withdrawBody } from "./quotes.schemas";

/** quote review → /concierge/payment → /concierge/success */
export const conciergeQuotesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge/requests", tag: "Concierge", defaultAuth: "customer" })
  .get("/:id/quote", { summary: "Current quote (lines, fees, deposit, expiry, amount due now)", params: idParam }, c.myQuote)
  .post("/:id/quote/accept", {
    summary: "Accept the quote and pay the deposit → `{ quote, payment }` (open payment.authorizationUrl)",
    description: "Delivery address: `addressId` (saved), `address` (typed) or the default shipping address. 409 `QUOTE_EXPIRED` once the quote has expired.",
    params: idParam,
    body: acceptBody,
    idempotent: "concierge.accept",
  }, c.accept)
  .post("/:id/quote/decline", { summary: "Decline the quote (optionally close the request)", params: idParam, body: declineBody }, c.decline)
  .post("/:id/pay-balance", { summary: "Pay the remaining balance (quotes with a deposit below 100 %)", params: idParam, body: payBalanceBody, idempotent: "concierge.balance" }, c.payBalance);

const audit = (action: string) => ({ category: "concierge", action, entity: "concierge_quote" });

/** asl-admin quote builder + /concierge/quotes */
export const conciergeQuotesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/concierge", tag: "Concierge", defaultAuth: "admin", defaultPermission: "concierge.quote" })
  .post("/requests/:id/quotes", {
    summary: "Send quote: lines + fees (defaults from settings `concierge`), tax from Admin → Tax, expiry `quoteValidityHours`",
    params: idParam,
    body: createQuoteBody,
    status: 201,
    audit: audit("concierge.quote_sent"),
  }, c.create)
  .post("/requests/:id/refund", {
    summary: "Refund money received on a request (to the original payment or the ASL Wallet), optionally cancelling it",
    description: "Default amount = everything paid. Refunding everything requires `cancelRequest`. With `cancelRequest`, whatever is not refunded is kept as a cancellation fee. Not available after delivery.",
    permission: ["concierge.quote", "orders.refund"],
    params: idParam,
    body: refundBody,
    audit: { category: "concierge", action: "concierge.refunded", entity: "concierge_request" },
  }, c.refund)
  .get("/quotes", { summary: "Quotes (tabs: pending / accepted / paid / expired / declined, KPIs)", permission: "concierge.view", query: adminQuotesQuery }, c.list)
  .get("/quotes/export", { summary: "Quotes CSV", permission: "concierge.view", query: adminQuotesQuery }, c.exportCsv)
  .get("/quotes/:id", { summary: "Quote (id or QT- number)", permission: "concierge.view", params: idParam }, c.get)
  .patch("/quotes/:id", { summary: "Revise an unpaid quote (validity restarts, customer notified)", params: idParam, body: reviseQuoteBody, audit: audit("concierge.quote_revised") }, c.revise)
  .post("/quotes/:id/withdraw", { summary: "Withdraw an unpaid quote (request back to sourcing)", params: idParam, body: withdrawBody, audit: audit("concierge.quote_withdrawn") }, c.withdraw);
