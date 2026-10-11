import { ModuleRouter, idParam } from "@/core/http/router";
import { returnsController as c } from "./returns.controller";
import {
  adminCreateBody, adminReturnsQuery, createReturnBody, investigateBody, myReturnsQuery, noteBody, receivedBody, refundBody, rejectBody,
} from "./returns.schemas";

/** "Start a return request" on an order */
export const returnableStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/orders", tag: "Returns", defaultAuth: "customer" })
  .get("/:id/returnable", { summary: "Per item: bought, returned, still returnable and why not (window, category, not delivered)", params: idParam }, c.returnable);

/** /account/returns */
export const myReturnsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/returns", tag: "Returns", defaultAuth: "customer" })
  .get("/", { summary: "My return requests (chips: In Progress / Approved / Completed / Rejected)", query: myReturnsQuery }, c.myReturns)
  .post("/", {
    summary: "Request a return (multipart: orderId, items = JSON [{orderItemId, qty}], reason, details, refundTo; up to 5 `photos`)",
    description: "Photos are required for \"Damaged or defective\" (reported within `returns.damagedReportHours` of delivery).",
    upload: { field: "photos", maxCount: 5, maxMB: 8 },
    body: createReturnBody,
    idempotent: "return.create",
    status: 201,
  }, c.create)
  .get("/:id", { summary: "Return detail: items, timeline, refund info (id or RET- number)", params: idParam }, c.myReturn)
  .post("/:id/cancel", { summary: "Cancel while still awaiting review", params: idParam }, c.cancel);

const audit = (action: string, category = "orders") => ({ category, action, entity: "return" });

/** asl-admin /returns */
export const returnsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/returns", tag: "Returns", defaultAuth: "admin", defaultPermission: "orders.edit" })
  .get("/", { summary: "Returns table (tabs, search, KPIs)", permission: "orders.view", query: adminReturnsQuery }, c.list)
  .post("/", { summary: "New RMA on behalf of a customer", body: adminCreateBody, status: 201, audit: audit("return.created") }, c.adminCreate)
  .get("/:id", { summary: "Return detail (id or RET- number) + suggested refund", permission: "orders.view", params: idParam }, c.get)
  .post("/:id/approve", { summary: "Approve", permission: "orders.refund", params: idParam, body: noteBody, audit: audit("return.approved") }, c.approve)
  .post("/:id/reject", { summary: "Reject with a reason (shown to the customer)", permission: "orders.refund", params: idParam, body: rejectBody, audit: audit("return.rejected") }, c.reject)
  .post("/:id/in-transit", { summary: "Customer shipped it back", params: idParam, body: noteBody, audit: audit("return.in_transit") }, c.inTransit)
  .post("/:id/received", { summary: "Received at the warehouse (optional restock)", params: idParam, body: receivedBody, audit: audit("return.received") }, c.received)
  .post("/:id/investigate", { summary: "Open an investigation (authenticity / condition)", params: idParam, body: investigateBody, audit: audit("return.investigating") }, c.investigate)
  .post("/:id/refund", { summary: "Refund to original payment or wallet", permission: "orders.refund", params: idParam, body: refundBody, audit: audit("return.refunded", "finance") }, c.refund);
