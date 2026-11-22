import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { posAdminController as c } from "./pos.admin.controller";
import {
  adminAuditQuery,
  adminPromoBody,
  adminPromoPatch,
  adminRegisterBody,
  adminReportsQuery,
  adminSessionsQuery,
  adminStockMovesQuery,
  adminTxQuery,
} from "./pos.admin.schemas";
import { adjustGiftCardBody, giftCardsQuery, issueGiftCardBody } from "./pos.schemas";

const audit = (action: string) => ({ category: "pos" as const, action, entity: "pos" });

/** Admin POS console — `/api/v1/admin/pos/*` */
export const posAdminRoutes = new ModuleRouter({
  surface: "admin",
  prefix: "/pos",
  tag: "POS admin",
  defaultAuth: "admin",
  defaultPermission: "pos.reports",
})
  .get("/overview", { summary: "POS dashboard metrics" }, c.overview)
  .get("/transactions", { summary: "Store-channel sales", query: adminTxQuery }, c.transactions)
  .get("/reports", { summary: "Sales / tender / credit reports", query: adminReportsQuery }, c.reports)
  .get("/registers", { summary: "Registers + open sessions", permission: "pos.manage" }, c.listRegisters)
  .post("/registers", {
    summary: "Create or update a register",
    body: adminRegisterBody,
    permission: "pos.manage",
    audit: audit("pos.register_upsert"),
  }, c.upsertRegister)
  .get("/sessions", { summary: "Register sessions", query: adminSessionsQuery, permission: "pos.manage" }, c.listSessions)
  .get("/audit", { summary: "Till audit trail", query: adminAuditQuery, permission: "pos.manage" }, c.audit)
  .get("/stock-moves", { summary: "Transfers, counts, GRN snapshot", query: adminStockMovesQuery, permission: "pos.stock_adjust" }, c.stockMoves)
  .get("/promotions", { summary: "All POS promotions", permission: "pos.manage" }, c.listPromotions)
  .post("/promotions", {
    summary: "Create automatic promotion",
    body: adminPromoBody,
    status: 201,
    permission: "pos.manage",
    audit: audit("pos.promo_create"),
  }, c.createPromotion)
  .patch("/promotions/:id", {
    summary: "Update promotion",
    params: idParam,
    body: adminPromoPatch,
    permission: "pos.manage",
    audit: audit("pos.promo_update"),
  }, c.updatePromotion)
  .get("/gift-cards", { summary: "Gift cards", query: giftCardsQuery, permission: "pos.manage" }, c.listGiftCards)
  .get("/gift-cards/:code", { summary: "Gift card detail", params: z.object({ code: z.string().min(4).max(32) }), permission: "pos.manage" }, c.getGiftCard)
  .post("/gift-cards", {
    summary: "Issue gift card",
    body: issueGiftCardBody,
    status: 201,
    permission: "pos.manage",
    audit: audit("pos.giftcard_issue"),
  }, c.issueGiftCard)
  .post("/gift-cards/:code/adjust", {
    summary: "Adjust / cancel gift card",
    params: z.object({ code: z.string().min(4).max(32) }),
    body: adjustGiftCardBody,
    permission: "pos.manage",
    audit: audit("pos.giftcard_adjust"),
  }, c.adjustGiftCard)
  .get("/settings", { summary: "POS settings group", permission: "pos.manage" }, c.settings)
  .patch("/settings", {
    summary: "Update POS settings",
    body: z.record(z.string(), z.unknown()),
    permission: "pos.manage",
    audit: audit("pos.settings"),
  }, c.updateSettings);
