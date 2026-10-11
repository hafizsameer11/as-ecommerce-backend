import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { lookupLimiter } from "@/core/middleware/rate-limit";
import { ordersController as c } from "./orders.controller";
import {
  adminCancelBody, adminOrderQuery, bulkBody, cancelBody, lookupBody, markPaidBody, myOrdersQuery, noteBody, orderRef, payAgainBody, refundBody, statusBody,
} from "./orders.schemas";

/** /account/orders, order detail, /account/track */
export const myOrdersStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/orders", tag: "Orders", defaultAuth: "customer" })
  .get("/", { summary: "My orders (tabs: Processing / Shipped / Delivered / Cancelled / Returned) + stats", query: myOrdersQuery }, c.myOrders)
  .get("/:id", { summary: "Order detail + timeline (id or order number)", params: orderRef }, c.myOrder)
  .post("/:id/cancel", { summary: "Cancel (only before it is prepared)", params: orderRef, body: cancelBody }, c.cancel)
  .post("/:id/pay", { summary: "Pay the balance again after a failed payment", params: orderRef, body: payAgainBody, idempotent: "order.pay" }, c.pay)
  .post("/:id/reorder", { summary: "Add this order's items back to the bag", params: orderRef }, c.reorder);

const tokenParam = z.object({ token: z.string().min(20).max(64) });

/** guest order confirmation page + /customer-care/track-order */
export const ordersStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/orders", tag: "Orders" })
  .post("/lookup", { summary: "Track an order with number + email", body: lookupBody, middleware: [lookupLimiter] }, c.lookup)
  .get("/by-token/:token", { summary: "Order by its private access token (guest confirmation page)", params: tokenParam }, c.byToken)
  .post("/by-token/:token/pay", { summary: "Guest: pay again", params: tokenParam, body: payAgainBody, idempotent: "order.pay" }, c.payByToken);

const audit = (action: string, category = "orders") => ({ category, action, entity: "order" });

/** asl-admin /orders, /orders/:id */
export const ordersAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/orders", tag: "Orders", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .get("/", { summary: "Orders table (tabs, search, KPIs)", permission: "orders.view", query: adminOrderQuery }, c.list)
  .get("/export", { summary: "Export orders (CSV)", permission: "orders.view", query: adminOrderQuery }, c.exportCsv)
  .get("/:id", { summary: "Order detail (id or number)", permission: "orders.view", params: idParam }, c.get)
  .patch("/:id/status", { summary: "Move to the next status", params: idParam, body: statusBody, audit: audit("order.status_changed") }, c.setStatus)
  .post("/bulk", { summary: "Bulk status change", body: bulkBody, audit: audit("order.bulk_status") }, c.bulk)
  .post("/:id/cancel", { summary: "Cancel + refund", params: idParam, body: adminCancelBody, permission: "orders.refund", audit: audit("order.cancelled") }, c.adminCancel)
  .post("/:id/mark-paid", { summary: "Confirm a bank transfer / offline payment", params: idParam, body: markPaidBody, permission: "orders.refund", audit: audit("order.marked_paid", "finance") }, c.markPaid)
  .post("/:id/notes", { summary: "Add internal note", params: idParam, body: noteBody, status: 201 }, c.addNote)
  .delete("/:id/notes/:noteId", { summary: "Delete note", params: idParam.extend({ noteId: z.string().min(1).max(64) }) }, c.removeNote)
  .post("/:id/refund", { summary: "Refund (to card/bank or wallet, optional restock)", params: idParam, body: refundBody, permission: "orders.refund", audit: audit("order.refunded", "finance") }, c.refund);
