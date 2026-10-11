import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { ledgerService as svc } from "./ledger.service";
import type { AccountBody, AccountPatch, AccountsQuery, EntriesQuery, EntryBody, EntryPatch, PeriodQuery } from "./ledger.schemas";

type Id = { id: string };
type Code = { code: string };

export const ledgerController = {
  accounts: ({ query }: Ctx<unknown, AccountsQuery>) => svc.accounts(query),
  addAccount: async ({ body, res }: Ctx<AccountBody>) => {
    const a = await svc.addAccount(body);
    res.locals.audit = { entityId: a.code, after: a, summary: `Added ledger account ${a.code} ${a.name}` };
    return a;
  },
  renameAccount: ({ params, body }: Ctx<AccountPatch, unknown, Code>) => svc.renameAccount(params.code, body.name),
  archiveAccount: ({ params }: Ctx<unknown, unknown, Code>) => svc.setArchived(params.code, true),
  unarchiveAccount: ({ params }: Ctx<unknown, unknown, Code>) => svc.setArchived(params.code, false),

  entries: ({ query }: Ctx<unknown, EntriesQuery>) => svc.entries(query),
  exportEntries: async ({ query, res }: Ctx<unknown, EntriesQuery>) => sendCsv(res, "journal-entries", await svc.exportEntries(query)),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, admin, res }: Ctx<EntryBody>) => {
    const e = await svc.createManual(body, admin.email);
    res.locals.audit = { entityId: e.id, after: e, summary: `${e.status === "draft" ? "Drafted" : "Posted"} ${e.number}: ${e.description}` };
    return e;
  },
  update: async ({ params, body, res }: Ctx<EntryPatch, unknown, Id>) => {
    const r = await svc.updateDraft(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Edited draft ${r.after.number}` };
    return r.after;
  },
  postDraft: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const e = await svc.postDraft(params.id);
    res.locals.audit = { entityId: e.id, summary: `Posted ${e.number}` };
    return e;
  },
  void: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const e = await svc.void(params.id);
    res.locals.audit = { entityId: e.id, summary: `Voided ${e.number}` };
    return e;
  },
  remove: ({ params }: Ctx<unknown, unknown, Id>) => svc.removeDraft(params.id),

  trialBalance: ({ query }: Ctx<unknown, PeriodQuery>) => svc.trialBalance(query),
  exportTrialBalance: async ({ query, res }: Ctx<unknown, PeriodQuery>) => sendCsv(res, "trial-balance", await svc.exportTrialBalance(query)),
};
