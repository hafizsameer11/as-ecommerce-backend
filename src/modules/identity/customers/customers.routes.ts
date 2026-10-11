import { ModuleRouter, idParam } from "@/core/http/router";
import { customersController as c } from "./customers.controller";
import { customerListQuery, marketingBody, noteBody, noteParams, statusBody, tagBody, tagParams, tierBody, walletAdjustBody } from "./customers.schemas";

const audit = (action: string, severity?: "notice" | "warning") => ({ category: "customers", action, entity: "customer", severity });

/** asl-admin /customers */
export const customersAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/customers", tag: "Customers", defaultAuth: "admin", defaultPermission: "customers.edit" })
  .get("/", { summary: "Customers (tabs All/Active/VIP/Flagged/Blocked, search, sort spend|orders|createdAt|lastOrderAt)", permission: "customers.view", query: customerListQuery }, c.list)
  .get("/export", { summary: "Export customers (CSV, same filters as the list)", permission: "customers.view", query: customerListQuery }, c.exportCsv)
  .get("/:id", { summary: "Customer profile: stats, wallet, addresses, notes, tags, recent orders", permission: "customers.view", params: idParam }, c.get)
  .patch("/:id/status", { summary: "Set status (blocked signs the customer out everywhere)", params: idParam, body: statusBody, audit: audit("customer.status_changed", "notice") }, c.setStatus)
  .patch("/:id/tier", { summary: "Set tier", params: idParam, body: tierBody, audit: audit("customer.tier_changed") }, c.setTier)
  .post("/:id/marketing", { summary: "Marketing opt-in / out", params: idParam, body: marketingBody, audit: audit("customer.marketing_changed") }, c.setMarketing)
  .post("/:id/notes", { summary: "Add a note", params: idParam, body: noteBody, status: 201, audit: audit("customer.note_added") }, c.addNote)
  .delete("/:id/notes/:noteId", { summary: "Remove a note", params: noteParams, audit: audit("customer.note_removed") }, c.removeNote)
  .post("/:id/tags", { summary: "Add a tag", params: idParam, body: tagBody, audit: audit("customer.tag_added") }, c.addTag)
  .delete("/:id/tags/:tag", { summary: "Remove a tag", params: tagParams, audit: audit("customer.tag_removed") }, c.removeTag)
  .post("/:id/wallet-adjust", { summary: "Credit or debit the wallet", permission: "customers.wallet", params: idParam, body: walletAdjustBody, audit: audit("customer.wallet_adjusted", "notice") }, c.adjustWallet)
  .delete("/:id", { summary: "Delete customer: anonymise personal data (orders and ledger are kept)", params: idParam, audit: audit("customer.anonymised", "warning") }, c.remove);
