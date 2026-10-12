import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { settingsSchemas } from "@/modules/platform/settings/settings.defaults";

export const TIER_IDS = ["Standard", "Silver", "Gold", "Signature"] as const;
export const REWARD_CATEGORIES = ["shipping", "credit", "experience", "product", "concierge", "coupon"] as const;
export const REDEMPTION_STATUSES = ["pending", "fulfilled", "cancelled"] as const;

// ── customer ──
export const historyQuery = pageQuery.extend({ type: z.enum(["earned", "spent"]).optional() });
export const redemptionsQuery = pageQuery;
export const rewardParam = z.object({ id: z.string().min(1).max(64) });

// ── admin ──
export const tierParam = z.object({ id: z.enum(TIER_IDS) });
export const tierPatch = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: z.string().trim().max(20).optional(),
  /** rolling 12-month spend (kobo) */
  minSpend: z.number().int().min(0).optional(),
  /** 1.25 = 1.25× points */
  multiplier: z.number().min(0.1).max(10).optional(),
  perks: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  active: z.boolean().optional(),
});

export const rulesBody = settingsSchemas.club.partial();

const rewardBase = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  cost: z.number().int().min(1),
  category: z.enum(REWARD_CATEGORIES),
  /** credit: kobo to the wallet · coupon: percent off · shipping / others: ignored */
  value: z.number().int().min(0).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  eligibleTiers: z.array(z.enum(TIER_IDS)).min(1).default([...TIER_IDS]),
  /** null = unlimited */
  stock: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
});
export const rewardBody = rewardBase
  .refine((r) => r.category !== "credit" || (r.value ?? 0) > 0, { message: "Enter the credit amount", path: ["value"] })
  .refine((r) => r.category !== "coupon" || ((r.value ?? 0) >= 1 && (r.value ?? 0) <= 100), { message: "Percent must be 1–100", path: ["value"] });
export const rewardPatch = rewardBase.partial();
export const rewardListQuery = pageQuery.extend({
  category: z.enum(REWARD_CATEGORIES).optional(),
  active: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});
export const reorderBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });

export const adjustBody = z.object({
  customerId: z.string().min(1).max(64),
  delta: z.number().int().refine((n) => n !== 0, "Enter a number of points"),
  reason: z.string().trim().min(2).max(200),
});
export const ledgerQuery = pageQuery.extend({
  customerId: z.string().max(64).optional(),
  type: z.enum(["earned", "spent"]).optional(),
  kind: z.string().max(40).optional(),
});
export const customerParam = z.object({ customerId: z.string().min(1).max(64) });
export const adminRedemptionsQuery = pageQuery.extend({
  status: z.enum(["all", ...REDEMPTION_STATUSES]).default("all"),
  category: z.enum(REWARD_CATEGORIES).optional(),
  customerId: z.string().max(64).optional(),
});
export const fulfilBody = z.object({ note: z.string().trim().max(500).optional() });
export const cancelBody = z.object({ reason: z.string().trim().min(2).max(300) });

export type HistoryQuery = z.infer<typeof historyQuery>;
export type TierPatch = z.infer<typeof tierPatch>;
export type RulesBody = z.infer<typeof rulesBody>;
export type RewardBody = z.infer<typeof rewardBody>;
export type RewardPatch = z.infer<typeof rewardPatch>;
export type RewardListQuery = z.infer<typeof rewardListQuery>;
export type AdjustBody = z.infer<typeof adjustBody>;
export type LedgerQuery = z.infer<typeof ledgerQuery>;
export type AdminRedemptionsQuery = z.infer<typeof adminRedemptionsQuery>;
