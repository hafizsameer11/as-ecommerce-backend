import { ModuleRouter, idParam } from "@/core/http/router";
import { requestsController as c } from "./requests.controller";
import {
  adminRequestsQuery, assignBody, cancelBody, createRequestBody, myRequestsQuery, noteBody, numberParam, priorityBody, statusBody, supplierLinkBody, trackQuery,
} from "./requests.schemas";

/** /start-request, concierge shop, /account/requests, concierge cart, /track-request */
export const conciergeRequestsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge", tag: "Concierge", defaultAuth: "customer" })
  .post("/requests", {
    summary: "Submit a request (multipart: fields + up to 6 `images`) — from the form or a concierge-shop product",
    description:
      "Guests may submit: send `contactName` + `contactEmail` (they track it with the number + e-mail and get updates by e-mail). " +
      "Quotes can only be accepted and paid from an account; guest requests are linked to the account once its e-mail is verified.",
    auth: "optionalCustomer",
    upload: { field: "images", maxCount: 6, maxMB: 10 },
    body: createRequestBody,
    status: 201,
  }, c.create)
  .get("/requests", { summary: "My requests (tabs: all / progress / completed / cancelled)", query: myRequestsQuery }, c.myList)
  .get("/requests/:id", { summary: "Request detail (id or ASL number): timeline, current quote, labels", params: idParam }, c.myGet)
  .post("/requests/:id/cancel", { summary: "Cancel (before anything is paid)", params: idParam, body: cancelBody }, c.cancel)
  .get("/cart", { summary: "Concierge cart: open requests with their cart label + estimated summary" }, c.cart)
  .get("/track/:number", {
    summary: "Track a request by number + e-mail (/track-request). Signed-in owners can omit the e-mail.",
    auth: "optionalCustomer",
    params: numberParam,
    query: trackQuery,
  }, c.track);

const audit = (action: string) => ({ category: "concierge", action, entity: "concierge_request" });

/** asl-admin /concierge/inbox + /concierge/board */
export const conciergeRequestsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/concierge", tag: "Concierge", defaultAuth: "admin", defaultPermission: "concierge.view" })
  .get("/kpis", { summary: "Concierge KPIs: open, SLA at risk / breached, quoted value, conversion" }, c.kpis)
  .get("/requests", { summary: "Inbox (tabs by status + open / unassigned / SLA / VIP, priority, assignee, search, KPIs)", query: adminRequestsQuery }, c.list)
  .get("/requests/board", { summary: "Sourcing board: columns by status", query: adminRequestsQuery }, c.board)
  .get("/requests/:id", { summary: "Request (id or ASL number) with full timeline, quotes, thread", params: idParam }, c.get)
  .patch("/requests/:id/status", { summary: "Move status (validated transitions)", permission: "concierge.assign", params: idParam, body: statusBody, audit: audit("concierge.status_changed") }, c.setStatus)
  .post("/requests/:id/assign", { summary: "Assign to a team member (null = unassign)", permission: "concierge.assign", params: idParam, body: assignBody, audit: audit("concierge.assigned") }, c.assign)
  .patch("/requests/:id/priority", { summary: "Priority (re-times the SLA)", permission: "concierge.assign", params: idParam, body: priorityBody, audit: audit("concierge.priority_changed") }, c.setPriority)
  .patch("/requests/:id/supplier", { summary: "Link a supplier (null = remove)", permission: "concierge.assign", params: idParam, body: supplierLinkBody, audit: audit("concierge.supplier_linked") }, c.setSupplier)
  .post("/requests/:id/notes", { summary: "Add a timeline note (internal by default)", params: idParam, body: noteBody, audit: audit("concierge.note_added") }, c.addNote);
