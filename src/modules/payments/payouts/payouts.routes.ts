import { ModuleRouter, idParam } from "@/core/http/router";
import { payoutsController as c } from "./payouts.controller";
import { failBody, holdBody, payoutBody, payoutListQuery, payoutPatch } from "./payouts.schemas";

const audit = (action: string) => ({ category: "finance", action, entity: "payout" });
const read = { permission: "finance.view" as const };

/** asl-admin /payouts (amounts in kobo) */
export const payoutsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/payouts", tag: "Payouts", defaultAuth: "admin", defaultPermission: "finance.payouts" })
  .get("/", { summary: "Payouts (tabs by status, KPIs: next payout, paid last 30 days, pending)", ...read, query: payoutListQuery }, c.list)
  .get("/export", { summary: "Export payouts (CSV)", ...read, query: payoutListQuery }, c.exportCsv)
  .post("/sync", { summary: "Build settlements from captured payments now (also runs daily)", audit: audit("payout.synced") }, c.sync)
  .get("/:id", { summary: "Payout with its transactions (id or PO- number)", ...read, params: idParam }, c.get)
  .post("/", { summary: "Create payout manually", body: payoutBody, status: 201, audit: audit("payout.created") }, c.create)
  .patch("/:id", { summary: "Update notes / scheduled date", params: idParam, body: payoutPatch, audit: audit("payout.updated") }, c.update)
  .post("/:id/mark-paid", { summary: "Mark paid (books Dr bank / Cr clearing)", params: idParam, audit: audit("payout.paid") }, c.markPaid)
  .post("/:id/mark-failed", { summary: "Mark failed", params: idParam, body: failBody, audit: audit("payout.failed") }, c.markFailed)
  .post("/:id/retry", { summary: "Retry a failed payout (back to scheduled)", params: idParam, audit: audit("payout.retried") }, c.retry)
  .post("/:id/hold", { summary: "Put on hold", params: idParam, body: holdBody, audit: audit("payout.held") }, c.hold)
  .post("/:id/release", { summary: "Release a held payout", params: idParam, audit: audit("payout.released") }, c.release)
  .delete("/:id", { summary: "Delete (scheduled or failed only)", params: idParam, audit: audit("payout.deleted") }, c.remove);
