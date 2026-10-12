import type { Ctx } from "@/core/http/router";
import { referralsService as svc } from "./referrals.service";
import type { AdvocateListQuery, ConfigBody, ReferralListQuery } from "./referrals.schemas";

type Id = { id: string };
type Note = { note?: string };

export const referralsController = {
  // ── customer ──
  mine: ({ customerId }: Ctx) => svc.mine(customerId),
  click: ({ params }: Ctx<unknown, unknown, { code: string }>) => svc.click(params.code),
  lookup: ({ params }: Ctx<unknown, unknown, { code: string }>) => svc.lookup(params.code),

  // ── admin ──
  overview: () => svc.overview(),
  list: ({ query }: Ctx<unknown, ReferralListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  approve: async ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => {
    const r = await svc.approve(params.id, body.note, admin.name);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Approved referral of ${r.after.friendName} by ${r.after.advocateName}` };
    return r.after;
  },
  reject: async ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => {
    const r = await svc.setStatus(params.id, "rejected", body.note, admin.name);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Rejected referral of ${r.after.friendName}` };
    return r.after;
  },
  flag: async ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => {
    const r = await svc.setStatus(params.id, "flagged", body.note, admin.name);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Flagged referral of ${r.after.friendName}` };
    return r.after;
  },
  reopen: async ({ params, body, admin, res }: Ctx<Note, unknown, Id>) => {
    const r = await svc.setStatus(params.id, "pending", body.note, admin.name);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Reopened referral of ${r.after.friendName}` };
    return r.after;
  },
  advocates: ({ query }: Ctx<unknown, AdvocateListQuery>) => svc.advocates(query),
  setAdvocateStatus: async ({ params, body, res }: Ctx<{ status: "active" | "paused" | "banned" }, unknown, Id>) => {
    const r = await svc.setAdvocateStatus(params.id, body.status);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Advocate ${r.after.code} → ${r.after.status}` };
    return r.after;
  },
  config: () => svc.config(),
  updateConfig: async ({ body, admin, res }: Ctx<ConfigBody>) => {
    const r = await svc.updateConfig(body, admin.email);
    res.locals.audit = { entityId: "referrals", before: r.before, after: r.after, summary: "Updated referral programme" };
    return r.after;
  },
};
