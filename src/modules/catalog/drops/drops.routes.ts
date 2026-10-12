import { ModuleRouter, idParam } from "@/core/http/router";
import { dropsController as c } from "./drops.controller";
import {
  adminCancelReservationBody, adminDropsQuery, adminReservationsQuery, cancelReservationBody, createDropBody, dropReservationParams,
  myReservationsQuery, notifyMeBody, notifyMeQuery, payBalanceBody, reservationRef, reserveBody, updateDropBody,
} from "./drops.schemas";

/** /coming-soon, /drop/:id and the reserve block */
export const dropsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/drops", tag: "Drops" })
  .get("/", { summary: "Upcoming & live drops" }, c.list)
  .get("/:id", { summary: "One drop (+ my reservation when signed in)", params: idParam, auth: "optionalCustomer" }, c.get)
  .post("/:id/reserve", {
    summary: "Reserve: pay the deposit (returns the reservation + payment to open)",
    description: "One active reservation per customer per drop (`ALREADY_RESERVED`); a full allocation answers `OUT_OF_STOCK`. Calling again while the deposit is unpaid opens a new payment for the same reservation.",
    auth: "customer", params: idParam, body: reserveBody, idempotent: "drops.reserve", status: 201,
  }, c.reserve);

/** account → reservations (deposit / balance panel) */
export const myReservationsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/reservations", tag: "Drops", defaultAuth: "customer" })
  .get("/", { summary: "My drop reservations (tabs: active / past)", query: myReservationsQuery }, c.myReservations)
  .get("/:id", { summary: "One reservation (id or RSV- number): deposit, balance due, pay-balance window", params: reservationRef }, c.myReservation)
  .post("/:id/cancel", { summary: "Cancel before the drop (deposit refunded per settings)", params: reservationRef, body: cancelReservationBody }, c.cancelMine)
  .post("/:id/pay-balance", {
    summary: "Pay the balance once the piece has dropped → a paid order",
    params: reservationRef, body: payBalanceBody, idempotent: "drops.pay-balance",
  }, c.payBalance);

/** "Notify me" when a sold-out product / size is back */
export const stockAlertsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/products/:id/notify-me", tag: "Products", defaultAuth: "customer" })
  .post("/", { summary: "Notify me when back in stock", params: idParam, body: notifyMeBody }, c.notifyMe)
  .delete("/", { summary: "Stop notifying", params: idParam, query: notifyMeQuery }, c.stopNotifying);

const audit = (action: string, entity = "drop") => ({ category: "catalog", action, entity });

/** asl-admin drops (U7: no screen yet — endpoints ready) */
export const dropsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/drops", tag: "Drops", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "Drops with KPIs (allocation, reserved, deposits, conversion)", permission: "catalog.view", query: adminDropsQuery }, c.adminList)
  .post("/", { summary: "Create a drop for a product", body: createDropBody, status: 201, audit: audit("drop.created") }, c.create)
  .get("/:id", { summary: "One drop + reservation stats", permission: "catalog.view", params: idParam }, c.adminGet)
  .patch("/:id", { summary: "Update release date, allocation, deposit %, teaser", params: idParam, body: updateDropBody, audit: audit("drop.updated") }, c.update)
  .post("/:id/go-live", { summary: "Release now (holds stock for reservations, notifies holders)", params: idParam, audit: audit("drop.released") }, c.goLive)
  .post("/:id/end", { summary: "End the drop (outstanding reservations cancelled, deposits refunded)", params: idParam, audit: audit("drop.ended") }, c.end)
  .get("/:id/reservations", { summary: "Reservations for a drop (tabs by status)", permission: "catalog.view", params: idParam, query: adminReservationsQuery }, c.reservations)
  .get("/:id/reservations/:rid", { summary: "One reservation", permission: "catalog.view", params: dropReservationParams }, c.reservation)
  .post("/:id/reservations/:rid/cancel", {
    summary: "Cancel a reservation (deposit refunded to card / wallet, or kept)",
    params: dropReservationParams, body: adminCancelReservationBody, audit: audit("reservation.cancelled", "reservation"),
  }, c.cancelReservation);
