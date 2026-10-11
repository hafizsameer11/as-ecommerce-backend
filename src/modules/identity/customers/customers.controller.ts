import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { formatNaira } from "@/core/utils/money";
import { customersService as svc } from "./customers.service";
import type { CustomerListQuery, StatusBody, TierBody, WalletAdjustBody } from "./customers.schemas";

type Id = { id: string };

export const customersController = {
  list: ({ query }: Ctx<unknown, CustomerListQuery>) => svc.list(query),
  exportCsv: async ({ query, res }: Ctx<unknown, CustomerListQuery>) => sendCsv(res, "customers", await svc.exportCsv(query)),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),

  setStatus: async ({ params, body, res }: Ctx<StatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body);
    res.locals.audit = {
      before: { status: r.before.status }, after: { status: r.after.status, reason: body.reason },
      summary: `${r.after.name}: status ${r.before.status} → ${r.after.status}${body.reason ? ` (${body.reason})` : ""}`,
    };
    return r.after;
  },
  setTier: async ({ params, body, res }: Ctx<TierBody, unknown, Id>) => {
    const r = await svc.setTier(params.id, body);
    res.locals.audit = { before: { tier: r.before.tier }, after: { tier: r.after.tier }, summary: `${r.after.name}: tier ${r.before.tier} → ${r.after.tier}` };
    return r.after;
  },
  setMarketing: async ({ params, body, res }: Ctx<{ optIn: boolean }, unknown, Id>) => {
    const r = await svc.setMarketing(params.id, body.optIn);
    res.locals.audit = { after: { marketingOptIn: body.optIn }, summary: `${r.name}: marketing ${body.optIn ? "opted in" : "opted out"}` };
    return r;
  },
  addNote: async ({ params, body, admin, res }: Ctx<{ body: string }, unknown, Id>) => {
    const n = await svc.addNote(params.id, body.body, admin.name);
    res.locals.audit = { after: n, summary: "Added a customer note" };
    return n;
  },
  removeNote: async ({ params, res }: Ctx<unknown, unknown, Id & { noteId: string }>) => {
    const n = await svc.removeNote(params.id, params.noteId);
    res.locals.audit = { before: n, summary: "Removed a customer note" };
    return { removed: true };
  },
  addTag: async ({ params, body, res }: Ctx<{ tag: string }, unknown, Id>) => {
    const tags = await svc.addTag(params.id, body.tag);
    res.locals.audit = { after: { tags }, summary: `Tagged "${body.tag}"` };
    return { tags };
  },
  removeTag: async ({ params, res }: Ctx<unknown, unknown, Id & { tag: string }>) => {
    const tags = await svc.removeTag(params.id, params.tag);
    res.locals.audit = { after: { tags }, summary: `Removed tag "${params.tag}"` };
    return { tags };
  },
  adjustWallet: async ({ params, body, admin, res }: Ctx<WalletAdjustBody, unknown, Id>) => {
    const r = await svc.adjustWallet(params.id, body, admin.name);
    res.locals.audit = { after: r.transaction, summary: `Wallet ${body.amount > 0 ? "credit" : "debit"} ${formatNaira(Math.abs(body.amount))}: ${body.note}` };
    return r;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const before = await svc.anonymise(params.id);
    // keep only non-identifying fields in the audit trail
    res.locals.audit = { before: { tier: before.tier, status: before.status, orders: before.orders }, summary: "Customer deleted (personal data anonymised, orders kept)" };
    return { anonymised: true };
  },
};
