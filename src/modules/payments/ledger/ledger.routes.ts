import { ModuleRouter, idParam } from "@/core/http/router";
import { ledgerController as c } from "./ledger.controller";
import { accountBody, accountCodeParam, accountPatch, accountsQuery, entriesQuery, entryBody, entryPatch, periodQuery } from "./ledger.schemas";

const audit = (action: string, entity = "journal_entry") => ({ category: "finance", action, entity });
const read = { permission: "finance.view" as const };

/** asl-admin /ledger (amounts in kobo) */
export const ledgerAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/ledger", tag: "Ledger", defaultAuth: "admin", defaultPermission: "finance.ledger" })
  // chart of accounts
  .get("/accounts", { summary: "Chart of accounts with debit / credit / balance (signed by normal side)", ...read, query: accountsQuery }, c.accounts)
  .post("/accounts", { summary: "Add account", body: accountBody, status: 201, audit: audit("ledger.account_added", "ledger_account") }, c.addAccount)
  .patch("/accounts/:code", { summary: "Rename account", params: accountCodeParam, body: accountPatch, audit: audit("ledger.account_renamed", "ledger_account") }, c.renameAccount)
  .post("/accounts/:code/archive", { summary: "Archive account (no new postings)", params: accountCodeParam, audit: audit("ledger.account_archived", "ledger_account") }, c.archiveAccount)
  .post("/accounts/:code/unarchive", { summary: "Unarchive account", params: accountCodeParam, audit: audit("ledger.account_unarchived", "ledger_account") }, c.unarchiveAccount)
  // journal entries
  .get("/entries", { summary: "Journal entries (filters: source, status, account, from/to, q) + status tabs", ...read, query: entriesQuery }, c.entries)
  .get("/entries/export", { summary: "Export journal lines (CSV)", ...read, query: entriesQuery }, c.exportEntries)
  .get("/entries/:id", { summary: "Journal entry (id or JE- number)", ...read, params: idParam }, c.get)
  .post("/entries", { summary: "Manual entry (draft or posted; must balance)", body: entryBody, status: 201, audit: audit("ledger.entry_created") }, c.create)
  .patch("/entries/:id", { summary: "Edit a draft entry", params: idParam, body: entryPatch, audit: audit("ledger.entry_updated") }, c.update)
  .post("/entries/:id/post", { summary: "Post a draft", params: idParam, audit: audit("ledger.entry_posted") }, c.postDraft)
  .post("/entries/:id/void", { summary: "Void an entry (kept, excluded from balances)", params: idParam, audit: audit("ledger.entry_voided") }, c.void)
  .delete("/entries/:id", { summary: "Delete a draft", params: idParam, audit: audit("ledger.entry_deleted") }, c.remove)
  // reports
  .get("/trial-balance", { summary: "Trial balance (posted entries in the period)", ...read, query: periodQuery }, c.trialBalance)
  .get("/trial-balance/export", { summary: "Export trial balance (CSV)", ...read, query: periodQuery }, c.exportTrialBalance);
