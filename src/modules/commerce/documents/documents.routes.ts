import { ModuleRouter } from "@/core/http/router";
import { documentsController as c } from "./documents.controller";
import { emailInvoiceBody, orderRef, orderToken, printSlipsBody } from "./documents.schemas";

const pdf = "Returns `application/pdf`.";

/** account order detail → "Download invoice" */
export const myOrderDocumentsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/orders", tag: "Orders", defaultAuth: "customer" })
  .get("/:id/invoice.pdf", { summary: "Invoice PDF for one of my orders (id or number)", description: pdf, params: orderRef }, c.myInvoice);

/** guest order confirmation page */
export const orderDocumentsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/orders", tag: "Orders" })
  .get("/by-token/:token/invoice.pdf", { summary: "Invoice PDF by the order's private access token", description: pdf, params: orderToken }, c.invoiceByToken);

/** asl-admin order detail buttons + "Print slips" bulk action */
export const orderDocumentsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/orders", tag: "Orders", defaultAuth: "admin", defaultPermission: "orders.view" })
  .post("/print-slips", { summary: "Packing slips for several orders (one PDF, one page per order)", description: pdf, body: printSlipsBody }, c.printSlips)
  .get("/:id/invoice.pdf", { summary: "Invoice PDF", description: pdf, params: orderRef }, c.invoice)
  .get("/:id/packing-slip.pdf", { summary: "Packing slip PDF (no prices)", description: pdf, params: orderRef }, c.packingSlip)
  .post("/:id/email-invoice", { summary: "Email the invoice PDF to the customer", params: orderRef, body: emailInvoiceBody, permission: "orders.edit", audit: { category: "orders", action: "order.invoice_emailed", entity: "order" } }, c.emailInvoice);
