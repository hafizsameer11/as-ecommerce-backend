import type { ClubReward, ClubTier, CustomerTier, PointsEntry, RewardRedemption } from "@/generated/prisma/client";
import { fullName } from "@/modules/identity/auth/customer.mapper";

export const tierList = (t: unknown) => (Array.isArray(t) ? (t as CustomerTier[]) : []);

/** admin /club tier card + customer tier ladder */
export const toTier = (t: ClubTier) => ({
  id: t.id,
  name: t.name,
  color: t.color,
  minSpend: Number(t.minSpend),
  multiplier: t.multiplierX100 / 100,
  pointsMultiplier: t.multiplierX100 / 100,
  perks: (t.perks as string[]) ?? [],
  active: t.active,
  position: t.position,
});

/** asl-admin ClubReward */
export const toAdminReward = (r: ClubReward) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  cost: r.cost,
  category: r.category,
  value: r.value,
  icon: r.icon,
  eligibleTiers: tierList(r.eligibleTiers),
  stock: r.stock,
  redeemed: r.redeemedCount,
  active: r.active,
  position: r.position,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const KIND_TITLE: Record<string, string> = {
  order: "Points Earned",
  signup: "Welcome Bonus",
  review: "Review Bonus",
  birthday: "Birthday Bonus",
  referral: "Referral Reward",
  redemption: "Points Redeemed",
  redemption_refund: "Points Returned",
  order_reversal: "Points Reversed",
  expiry: "Points Expired",
  adjustment: "Points Adjustment",
};

/** /account/rewards activity row */
export const toHistoryRow = (e: PointsEntry) => ({
  id: e.id,
  kind: e.refType ?? "adjustment",
  title: KIND_TITLE[e.refType ?? "adjustment"] ?? "Points",
  detail: e.reason,
  delta: e.delta,
  negative: e.delta < 0,
  expiresAt: e.delta > 0 ? e.expiresAt : null,
  createdAt: e.createdAt,
});

type EntryWithCustomer = PointsEntry & { customer: { id: string; firstName: string; lastName: string; email: string; tier: CustomerTier } };

/** admin /club "Recent points activity" (UI PointsEntry) */
export const toLedgerRow = (e: EntryWithCustomer) => ({
  id: e.id,
  customerId: e.customerId,
  customerName: fullName(e.customer),
  customerEmail: e.customer.email,
  tier: e.customer.tier,
  delta: e.delta,
  reason: e.reason,
  kind: e.refType ?? "adjustment",
  refId: e.refId,
  remaining: e.remaining,
  expiresAt: e.expiresAt,
  actor: e.actor,
  at: e.createdAt,
});

type RedemptionResult = { couponCode?: string; walletTxRef?: string; amount?: number; note?: string; fulfilledBy?: string; fulfilledAt?: string; cancelledBy?: string; reason?: string };

export const REDEMPTION_LABEL: Record<string, string> = { pending: "Being arranged", fulfilled: "Fulfilled", cancelled: "Cancelled" };

/** customer "my redemptions" */
export const toRedemption = (r: RewardRedemption & { reward: Pick<ClubReward, "id" | "title" | "category"> }) => {
  const res = (r.result ?? {}) as RedemptionResult;
  return {
    id: r.id,
    rewardId: r.reward.id,
    title: r.reward.title,
    category: r.reward.category,
    points: r.points,
    status: r.status,
    statusLabel: REDEMPTION_LABEL[r.status] ?? r.status,
    couponCode: res.couponCode ?? null,
    walletTxRef: res.walletTxRef ?? null,
    amount: res.amount ?? null,
    note: res.note ?? null,
    createdAt: r.createdAt,
  };
};

export const toAdminRedemption = (
  r: RewardRedemption & { reward: Pick<ClubReward, "id" | "title" | "category">; customer: { id: string; firstName: string; lastName: string; email: string; tier: CustomerTier } },
) => ({
  ...toRedemption(r),
  result: r.result,
  customer: { id: r.customer.id, name: fullName(r.customer), email: r.customer.email, tier: r.customer.tier },
});
