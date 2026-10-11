import type { Ctx } from "@/core/http/router";
import { walletsService as svc } from "./wallets.service";
import type { AdjustBody, AdminTxQuery, BankAccountBody, TopupBody, TxQuery, WithdrawBody } from "./wallets.schemas";

type Id = { id: string };

export const walletsController = {
  summary: ({ customerId }: Ctx) => svc.summary(customerId),
  transactions: ({ customerId, query }: Ctx<unknown, TxQuery>) => svc.transactions(customerId, query),
  topup: ({ customerId, body }: Ctx<TopupBody>) => svc.topup(customerId, body),
  withdraw: ({ customerId, body }: Ctx<WithdrawBody>) => svc.withdraw(customerId, body),

  banks: () => svc.listBanks(),
  resolve: ({ body }: Ctx<BankAccountBody>) => svc.resolveAccount(body.bankCode, body.accountNumber),
  myBankAccounts: ({ customerId }: Ctx) => svc.myBankAccounts(customerId),
  addBankAccount: ({ customerId, body }: Ctx<BankAccountBody>) => svc.addBankAccount(customerId, body),
  removeBankAccount: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.removeBankAccount(customerId, params.id),

  adminList: ({ query }: Ctx<unknown, AdminTxQuery>) => svc.adminTransactions(query),
  adjust: async ({ body, admin, res }: Ctx<AdjustBody>) => {
    const t = await svc.adjust(body, admin.name);
    res.locals.audit = { entityId: body.customerId, after: t, summary: `Wallet ${body.amount > 0 ? "credit" : "debit"} ₦${Math.abs(body.amount) / 100}: ${body.note}` };
    return t;
  },
  approve: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.payOut(params.id, admin.name),
  fail: ({ params, body, admin }: Ctx<{ reason: string }, unknown, Id>) => svc.failWithdrawal(params.id, admin.name, body.reason),
  reverse: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.reverse(params.id, admin.name),
  freeze: ({ params }: Ctx<unknown, unknown, { customerId: string }>) => svc.setFrozen(params.customerId, true),
  unfreeze: ({ params }: Ctx<unknown, unknown, { customerId: string }>) => svc.setFrozen(params.customerId, false),
};
