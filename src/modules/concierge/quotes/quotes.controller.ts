import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { quotesService as svc } from "./quotes.service";
import type { AcceptBody, AdminQuotesQuery, CreateQuoteBody, DeclineBody, PayBalanceBody, RefundBody, ReviseQuoteBody } from "./quotes.schemas";

type Id = { id: string };

export const quotesController = {
  // customer
  myQuote: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.myQuote(customerId, params.id),
  accept: ({ customerId, params, body }: Ctx<AcceptBody, unknown, Id>) => svc.accept(customerId, params.id, body),
  decline: ({ customerId, params, body }: Ctx<DeclineBody, unknown, Id>) => svc.decline(customerId, params.id, body),
  payBalance: ({ customerId, params, body }: Ctx<PayBalanceBody, unknown, Id>) => svc.payBalance(customerId, params.id, body),

  // admin
  refund: async ({ params, body, admin, res }: Ctx<RefundBody, unknown, Id>) => {
    const r = await svc.refund(params.id, body, admin);
    res.locals.audit = {
      entityId: r.requestId,
      summary: `Refunded ${r.refunded / 100} NGN on ${r.requestNumber} to ${r.to === "wallet" ? "ASL Wallet" : "original payment"}${r.cancelled ? " and cancelled it" : ""}: ${body.reason}`,
      after: { refunded: r.refunded, to: r.to, amountPaid: r.amountPaid, cancelled: r.cancelled },
    };
    return r;
  },
  create: async ({ params, body, admin, res }: Ctx<CreateQuoteBody, unknown, Id>) => {
    const q = await svc.create(params.id, body, admin);
    res.locals.audit = { entityId: q.id, summary: `Sent quote ${q.number} (${q.total / 100} NGN)`, after: { total: q.total, deposit: q.deposit, expiresAt: q.expiresAt } };
    return q;
  },
  revise: async ({ params, body, admin, res }: Ctx<ReviseQuoteBody, unknown, Id>) => {
    const q = await svc.revise(params.id, body, admin);
    res.locals.audit = { entityId: q.id, summary: `Revised quote ${q.number}`, after: { total: q.total, deposit: q.deposit, expiresAt: q.expiresAt } };
    return q;
  },
  withdraw: async ({ params, body, admin, res }: Ctx<{ reason?: string }, unknown, Id>) => {
    const q = await svc.withdraw(params.id, body.reason, admin);
    res.locals.audit = { entityId: q.id, summary: `Withdrew quote ${q.number}`, after: { status: q.status } };
    return q;
  },
  list: ({ query }: Ctx<unknown, AdminQuotesQuery>) => svc.adminList(query),
  exportCsv: async ({ query, res }: Ctx<unknown, AdminQuotesQuery>) => sendCsv(res, "concierge-quotes", await svc.exportCsv(query)),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
};
