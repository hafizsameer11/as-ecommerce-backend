import type { Ctx } from "@/core/http/router";
import type { CustomerTier } from "@/generated/prisma/client";
import { clubService as svc } from "./club.service";
import type {
  AdjustBody, AdminRedemptionsQuery, HistoryQuery, LedgerQuery, RewardBody, RewardListQuery, RewardPatch, RulesBody, TierPatch,
} from "./club.schemas";

type Id = { id: string };
type Page = { page: number; pageSize: number };

export const clubController = {
  // ── customer ──
  summary: ({ customerId }: Ctx) => svc.summary(customerId),
  history: ({ customerId, query }: Ctx<unknown, HistoryQuery>) => svc.history(customerId, query),
  rewards: ({ customerId }: Ctx) => svc.rewards(customerId),
  redeem: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.redeem(customerId, params.id),
  myRedemptions: ({ customerId, query }: Ctx<unknown, Page>) => svc.myRedemptions(customerId, query),

  // ── admin ──
  overview: () => svc.overview(),
  tiers: () => svc.tiers(),
  updateTier: async ({ params, body, res }: Ctx<TierPatch, unknown, { id: CustomerTier }>) => {
    const r = await svc.updateTier(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated ${params.id} tier` };
    return r.after;
  },
  rules: () => svc.rules(),
  updateRules: async ({ body, admin, res }: Ctx<RulesBody>) => {
    const r = await svc.updateRules(body, admin.email);
    res.locals.audit = { entityId: "club", before: r.before, after: r.after, summary: "Updated ASL Club rules" };
    return r.after;
  },
  adminRewards: ({ query }: Ctx<unknown, RewardListQuery>) => svc.adminRewards(query),
  getReward: ({ params }: Ctx<unknown, unknown, Id>) => svc.getReward(params.id),
  createReward: async ({ body, res }: Ctx<RewardBody>) => {
    const r = await svc.createReward(body);
    res.locals.audit = { entityId: r.id, after: r, summary: `Created reward "${r.title}"` };
    return r;
  },
  updateReward: async ({ params, body, res }: Ctx<RewardPatch, unknown, Id>) => {
    const r = await svc.updateReward(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated reward "${r.after.title}"` };
    return r.after;
  },
  duplicateReward: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.duplicateReward(params.id);
    res.locals.audit = { entityId: r.id, after: r, summary: `Duplicated reward as "${r.title}"` };
    return r;
  },
  toggleReward: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.toggleReward(params.id);
    res.locals.audit = { entityId: params.id, summary: `Reward "${r.title}" ${r.active ? "switched on" : "switched off"}` };
    return r;
  },
  reorderRewards: ({ body }: Ctx<{ ids: string[] }>) => svc.reorderRewards(body.ids),
  removeReward: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.removeReward(params.id);
    res.locals.audit = { entityId: params.id, before: r.before, summary: `Deleted reward "${r.before.title}"` };
    return { deleted: true };
  },
  adjust: async ({ body, admin, res }: Ctx<AdjustBody>) => {
    const r = await svc.adjust(body, admin.name);
    res.locals.audit = { entityId: body.customerId, after: r, summary: `${body.delta > 0 ? "+" : ""}${body.delta} points — ${body.reason}` };
    return r;
  },
  ledger: ({ query }: Ctx<unknown, LedgerQuery>) => svc.ledger(query),
  customerSummary: ({ params }: Ctx<unknown, unknown, { customerId: string }>) => svc.customerSummary(params.customerId),
  adminRedemptions: ({ query }: Ctx<unknown, AdminRedemptionsQuery>) => svc.adminRedemptions(query),
  fulfilRedemption: async ({ params, body, admin, res }: Ctx<{ note?: string }, unknown, Id>) => {
    const r = await svc.fulfilRedemption(params.id, body.note, admin.name);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Fulfilled "${r.after.title}" for ${r.after.customer.name}` };
    return r.after;
  },
  cancelRedemption: async ({ params, body, admin, res }: Ctx<{ reason: string }, unknown, Id>) => {
    const r = await svc.cancelRedemption(params.id, body.reason, admin.name);
    res.locals.audit = { entityId: params.id, after: r.after, summary: `Cancelled "${r.after.title}" for ${r.after.customer.name} — points returned` };
    return r.after;
  },
};
