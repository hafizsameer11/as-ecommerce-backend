import { ModuleRouter, idParam } from "@/core/http/router";
import { posController as c } from "./pos.controller";
import {
  cashMoveBody,
  catalogQuery,
  closeSessionBody,
  completeSaleBody,
  createCustomerBody,
  customersQuery,
  openSessionBody,
  pinLoginBody,
  quoteBody,
  syncSalesBody,
} from "./pos.schemas";

const audit = (action: string) => ({ category: "pos" as const, action, entity: "pos" });

/** Till APIs — separate surface from store + admin. Auth is staff JWT (PIN login). */
export const posAuthRoutes = new ModuleRouter({ surface: "pos", prefix: "/auth", tag: "Auth" })
  .post("/pin", { summary: "Sign in with till PIN", body: pinLoginBody, auth: "public" }, c.pinLogin);

export const posRoutes = new ModuleRouter({
  surface: "pos",
  prefix: "",
  tag: "Till",
  defaultAuth: "admin",
  defaultPermission: "pos.sell",
})
  .get("/me", { summary: "Signed-in till staff + discount limit" }, c.me)
  .get("/settings", { summary: "POS settings for this till" }, c.settings)
  .get("/registers", { summary: "Registers this staff can use" }, c.listRegisters)
  .post("/registers/:id/open", {
    summary: "Open a register session with a float",
    permission: "pos.open_close",
    params: idParam,
    body: openSessionBody,
    audit: audit("pos.session_opened"),
  }, c.openSession)
  .post("/sessions/:id/cash-moves", {
    summary: "Pay in / pay out",
    permission: "pos.cash_moves",
    params: idParam,
    body: cashMoveBody,
    audit: audit("pos.cash_move"),
  }, c.cashMove)
  .post("/sessions/:id/close", {
    summary: "Close session with counted cash + Z report",
    permission: "pos.open_close",
    params: idParam,
    body: closeSessionBody,
    audit: audit("pos.session_closed"),
  }, c.closeSession)
  .get("/sessions/:id/z-report", {
    summary: "Z report for a session",
    permission: "pos.reports",
    params: idParam,
  }, c.zReport)
  .get("/catalog", { summary: "Products for the till (send X-Pos-Register for local stock)", query: catalogQuery }, c.catalog)
  .get("/catalog/:id", { summary: "Product detail + stock by location", params: idParam }, c.product)
  .get("/customers", { summary: "Search customers", query: customersQuery, permission: "customers.view" }, c.customers)
  .post("/customers", { summary: "Create walk-in customer", body: createCustomerBody, permission: "customers.edit", status: 201 }, c.createCustomer)
  .post("/sales/quote", { summary: "Price a basket (VAT inclusive)", body: quoteBody }, c.quote)
  .post("/sales", {
    summary: "Complete an in-store sale",
    body: completeSaleBody,
    status: 201,
    idempotent: "pos-sale",
    audit: audit("pos.sale"),
  }, c.completeSale)
  .post("/sales/sync", {
    summary: "Sync offline sales (idempotent per clientKey)",
    body: syncSalesBody,
    audit: audit("pos.sync"),
  }, c.syncSales)
  .get("/sales/:id", { summary: "Sale / receipt payload", params: idParam }, c.getSale);
