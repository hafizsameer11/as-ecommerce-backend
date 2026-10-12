import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { payoutsService as svc } from "./payouts.service";
import type { PayoutBody, PayoutListQuery, PayoutPatch } from "./payouts.schemas";

type Id = { id: string };

export const payoutsController = {
  list: ({ query }: Ctx<unknown, PayoutListQuery>) => svc.list(query),
  exportCsv: async ({ query, res }: Ctx<unknown, PayoutListQuery>) => sendCsv(res, "payouts", await svc.exportCsv(query)),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<PayoutBody>) => {
    const p = await svc.create(body);
    res.locals.audit = { entityId: p.id, after: p, summary: `Created payout ${p.number} (${p.providerLabel})` };
    return p;
  },
  update: async ({ params, body, res }: Ctx<PayoutPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { entityId: r.after.id, before: r.before, after: r.after, summary: `Updated payout ${r.after.number}` };
    return r.after;
  },
  markPaid: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const p = await svc.markPaid(params.id);
    res.locals.audit = { entityId: p.id, summary: `Payout ${p.number} marked paid` };
    return p;
  },
  markFailed: async ({ params, body, res }: Ctx<{ reason: string }, unknown, Id>) => {
    const p = await svc.markFailed(params.id, body.reason);
    res.locals.audit = { entityId: p.id, summary: `Payout ${p.number} failed: ${body.reason}` };
    return p;
  },
  retry: ({ params }: Ctx<unknown, unknown, Id>) => svc.retry(params.id),
  hold: async ({ params, body, res }: Ctx<{ note: string }, unknown, Id>) => {
    const p = await svc.hold(params.id, body.note);
    res.locals.audit = { entityId: p.id, summary: `Payout ${p.number} on hold: ${body.note}` };
    return p;
  },
  release: ({ params }: Ctx<unknown, unknown, Id>) => svc.release(params.id),
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { summary: `Deleted payout ${r.number}` };
    return r;
  },
  sync: () => svc.sync(),
  providers: () => svc.providers(),
};
