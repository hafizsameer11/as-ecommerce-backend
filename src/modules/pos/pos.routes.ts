import { ModuleRouter, idParam } from "@/core/http/router";
import { pageQuery } from "@/core/http/pagination";
import { posController as c } from "./pos.controller";
import {
  adjustGiftCardBody,
  alterationStatusBody,
  cashMoveBody,
  catalogQuery,
  closeSessionBody,
  collectPickupBody,
  completeSaleBody,
  adjustStockBody,
  createAlterationBody,
  createConciergeBody,
  createCustomerBody,
  createGrnBody,
  createStockCountBody,
  createTransferBody,
  customersQuery,
  giftCardsQuery,
  issueGiftCardBody,
  openSessionBody,
  pickupsQuery,
  pinLoginBody,
  posReturnBody,
  quoteBody,
  receiveGrnBody,
  salesListQuery,
  advanceShipBody,
  sendReceiptBody,
  settleLayawayBody,
  cancelLayawayBody,
  shippingQuoteBody,
  syncSalesBody,
  transferStepBody,
} from "./pos.schemas";
import { z } from "zod";

const audit = (action: string) => ({ category: "pos" as const, action, entity: "pos" });
const id = z.string().min(1).max(64);

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
  .post("/sales/quote", { summary: "Price a basket (VAT inclusive, promos, ship/layaway)", body: quoteBody }, c.quote)
  .post("/sales/shipping-quote", { summary: "Shipping rates for ship-from-till", body: shippingQuoteBody }, c.shippingQuote)
  .post("/sales", {
    summary: "Complete an in-store sale (or layaway / ship-to)",
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
  .get("/sales", { summary: "List store sales (layaway / ship / instore)", query: salesListQuery }, c.listSales)
  .get("/sales/:id", { summary: "Sale / receipt payload", params: idParam }, c.getSale)
  .post("/sales/:id/send-receipt", {
    summary: "Send receipt by email (SMS/WhatsApp still queue as pending)",
    params: idParam,
    body: sendReceiptBody,
    audit: audit("pos.receipt_queued"),
  }, c.sendReceipt)
  .post("/sales/:id/advance-ship", {
    summary: "Mark a ship-from-till sale shipped or delivered",
    params: idParam,
    body: advanceShipBody,
    audit: audit("pos.ship_advance"),
  }, c.advanceShip)
  .get("/sales/:id/returnable", { summary: "What can be returned on this sale", params: idParam }, c.returnable)
  .post("/sales/:id/returns", {
    summary: "Process an in-store return + refund",
    permission: "pos.refund",
    params: idParam,
    body: posReturnBody,
    status: 201,
    audit: audit("pos.return"),
  }, c.processReturn)
  .post("/sales/:id/layaway/settle", {
    summary: "Pay layaway balance and hand over",
    params: idParam,
    body: settleLayawayBody,
    audit: audit("pos.layaway_settle"),
  }, c.settleLayaway)
  .post("/sales/:id/layaway/cancel", {
    summary: "Cancel an open layaway (releases hold)",
    params: idParam,
    body: cancelLayawayBody,
    audit: audit("pos.layaway_cancel"),
  }, c.cancelLayaway)
  .get("/pickups", { summary: "Pickup queue for this boutique", query: pickupsQuery }, c.pickups)
  .post("/pickups/:id/ready", {
    summary: "Mark pickup ready (queues customer notify as pending)",
    params: idParam,
    audit: audit("pos.pickup_ready"),
  }, c.pickupReady)
  .post("/pickups/:id/collect", {
    summary: "Hand over pickup (code or ID check)",
    params: idParam,
    body: collectPickupBody,
    audit: audit("pos.pickup_collected"),
  }, c.pickupCollect)
  .get("/gift-cards", { summary: "List gift cards", query: giftCardsQuery, permission: "pos.manage" }, c.listGiftCards)
  .get("/gift-cards/:code", { summary: "Gift card balance", params: z.object({ code: z.string().min(4).max(32) }) }, c.getGiftCard)
  .post("/gift-cards", {
    summary: "Issue a gift card",
    body: issueGiftCardBody,
    status: 201,
    permission: "pos.manage",
    audit: audit("pos.giftcard_issue"),
  }, c.issueGiftCard)
  .post("/gift-cards/:code/adjust", {
    summary: "Adjust or cancel a gift card",
    params: z.object({ code: z.string().min(4).max(32) }),
    body: adjustGiftCardBody,
    permission: "pos.manage",
    audit: audit("pos.giftcard_adjust"),
  }, c.adjustGiftCard)
  .get("/promotions", { summary: "Active automatic promotions for this till" }, c.listPromotions)
  .get("/alterations", {
    summary: "Alteration tickets",
    query: pageQuery.extend({ locationId: id.optional(), status: z.enum(["received", "with-tailor", "ready", "collected"]).optional() }),
  }, c.listAlterations)
  .post("/alterations", {
    summary: "Create alteration ticket",
    body: createAlterationBody,
    status: 201,
    audit: audit("pos.alteration"),
  }, c.createAlteration)
  .post("/alterations/:id/status", {
    summary: "Update alteration status",
    params: idParam,
    body: alterationStatusBody,
    audit: audit("pos.alteration_status"),
  }, c.alterationStatus)
  .post("/stock/adjust", {
    summary: "Adjust on-hand at a boutique warehouse",
    body: adjustStockBody,
    permission: "pos.stock_adjust",
    audit: audit("pos.stock_adjust"),
  }, c.adjustStock)
  .get("/transfers", {
    summary: "Stock transfers",
    query: pageQuery.extend({ warehouseId: id.optional(), status: z.string().max(16).optional() }),
    permission: "pos.stock_adjust",
  }, c.listTransfers)
  .post("/transfers", {
    summary: "Request a stock transfer",
    body: createTransferBody,
    status: 201,
    permission: "pos.stock_adjust",
    audit: audit("pos.transfer"),
  }, c.createTransfer)
  .post("/transfers/:id/step", {
    summary: "Approve / ship / receive / reject a transfer",
    params: idParam,
    body: transferStepBody,
    permission: "pos.stock_adjust",
    audit: audit("pos.transfer_step"),
  }, c.stepTransfer)
  .get("/stock-counts", {
    summary: "Stock counts",
    query: pageQuery.extend({ warehouseId: id.optional() }),
    permission: "pos.stock_adjust",
  }, c.listCounts)
  .post("/stock-counts", {
    summary: "Open a stock count",
    body: createStockCountBody,
    status: 201,
    permission: "pos.stock_adjust",
    audit: audit("pos.count"),
  }, c.createCount)
  .post("/stock-counts/:id/post", {
    summary: "Post count variances to inventory",
    params: idParam,
    permission: "pos.stock_adjust",
    audit: audit("pos.count_post"),
  }, c.postCount)
  .get("/grn", {
    summary: "Goods receipts",
    query: pageQuery.extend({ warehouseId: id.optional(), status: z.string().max(16).optional() }),
    permission: "pos.stock_adjust",
  }, c.listGrn)
  .post("/grn", {
    summary: "Create expected GRN",
    body: createGrnBody,
    status: 201,
    permission: "pos.stock_adjust",
    audit: audit("pos.grn"),
  }, c.createGrn)
  .post("/grn/:id/receive", {
    summary: "Receive GRN lines into stock",
    params: idParam,
    body: receiveGrnBody,
    permission: "pos.stock_adjust",
    audit: audit("pos.grn_receive"),
  }, c.receiveGrn)
  .post("/concierge", {
    summary: "Log a concierge request from the till",
    body: createConciergeBody,
    status: 201,
    audit: audit("pos.concierge"),
  }, c.createConcierge);
