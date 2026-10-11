import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { walletsController as c } from "./wallets.controller";
import { adjustBody, adminTxQuery, bankAccountBody, failBody, topupBody, txQuery, withdrawBody } from "./wallets.schemas";

/** /account/wallet, /account/wallet/topup, /account/wallet/withdraw */
export const walletStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/wallet", tag: "Wallet", defaultAuth: "customer" })
  .get("/", { summary: "Balance, total spent, limits, recent activity" }, c.summary)
  .get("/transactions", { summary: "Wallet history", query: txQuery }, c.transactions)
  .post("/topup", { summary: "Top up → returns payment `authorizationUrl`", body: topupBody, idempotent: "wallet.topup" }, c.topup)
  .post("/withdraw", { summary: "Withdraw to a saved bank account", body: withdrawBody, idempotent: "wallet.withdraw" }, c.withdraw);

export const bankAccountsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/bank-accounts", tag: "Wallet", defaultAuth: "customer" })
  .get("/", { summary: "My bank accounts" }, c.myBankAccounts)
  .post("/", { summary: "Add bank account (account name is verified)", body: bankAccountBody, status: 201 }, c.addBankAccount)
  .delete("/:id", { summary: "Remove bank account", params: idParam }, c.removeBankAccount);

export const banksStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/banks", tag: "Wallet" })
  .get("/", { summary: "Nigerian banks (withdraw form)" }, c.banks)
  .post("/resolve", { summary: "Look up the account name", auth: "customer", body: bankAccountBody }, c.resolve);

const audit = (action: string) => ({ category: "finance", action, entity: "wallet" });
const customerParam = z.object({ customerId: z.string().min(1).max(64) });

/** asl-admin /wallets */
export const walletsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/wallets", tag: "Wallets", defaultAuth: "admin", defaultPermission: "customers.wallet" })
  .get("/transactions", { summary: "All wallet transactions (tabs by kind / status) + total liabilities", permission: ["finance.view"], query: adminTxQuery }, c.adminList)
  .post("/adjust", { summary: "Credit or debit a customer wallet", body: adjustBody, audit: audit("wallet.adjusted") }, c.adjust)
  .post("/transactions/:id/approve", { summary: "Pay out a pending withdrawal", params: idParam, audit: audit("wallet.withdrawal_approved") }, c.approve)
  .post("/transactions/:id/mark-failed", { summary: "Fail a pending withdrawal (money returns to balance)", params: idParam, body: failBody, audit: audit("wallet.withdrawal_failed") }, c.fail)
  .post("/transactions/:id/reverse", { summary: "Reverse a completed transaction", params: idParam, audit: audit("wallet.reversed") }, c.reverse)
  .post("/:customerId/freeze", { summary: "Freeze wallet", params: customerParam, audit: audit("wallet.frozen") }, c.freeze)
  .post("/:customerId/unfreeze", { summary: "Unfreeze wallet", params: customerParam, audit: audit("wallet.unfrozen") }, c.unfreeze);
