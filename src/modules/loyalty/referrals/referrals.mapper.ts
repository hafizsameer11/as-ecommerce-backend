import type { Advocate, Referral, ReferralStatus } from "@/generated/prisma/client";
import { formatNaira } from "@/core/utils/money";

/** customer /account/referrals wording */
export const REFERRAL_LABEL: Record<ReferralStatus, string> = {
  pending: "Signed up",
  qualified: "Qualified",
  rewarded: "Rewarded",
  expired: "Expired",
  flagged: "Under review",
  rejected: "Not eligible",
};

export type RewardSpec = { type: "credit" | "points" | "percent" | "fixed"; value: number };

export function rewardLabel(r: RewardSpec, who: "advocate" | "friend") {
  switch (r.type) {
    case "credit": return `${formatNaira(r.value)} wallet credit`;
    case "points": return `${r.value.toLocaleString("en-NG")} ASL Club points`;
    case "percent": return who === "friend" ? `${r.value}% off their first order` : `${r.value}% off your next order`;
    case "fixed": return who === "friend" ? `${formatNaira(r.value)} off their first order` : `${formatNaira(r.value)} off your next order`;
  }
}

/** "Amaka Okafor" → "Amaka O." */
export const maskName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.pop();
  return last ? `${first} ${last[0].toUpperCase()}.` : first || "Friend";
};

/** customer list row */
export const toFriend = (r: Referral) => ({
  id: r.id,
  name: maskName(r.friendName),
  status: r.status,
  statusLabel: REFERRAL_LABEL[r.status],
  reward: r.status === "rewarded" ? r.reward : null,
  createdAt: r.createdAt,
});

type AdvocateWith = Advocate & { customer: { id: string; firstName: string; lastName: string; email: string } };

/** asl-admin Referral (money in kobo; `*Minor` aliases match the UI type) */
export const toAdminReferral = (r: Referral & { advocate: AdvocateWith }, orderNumber?: string | null) => ({
  id: r.id,
  advocateId: r.advocateId,
  advocateName: `${r.advocate.customer.firstName} ${r.advocate.customer.lastName}`.trim(),
  advocateCode: r.advocate.code,
  advocateCustomerId: r.advocate.customerId,
  friendCustomerId: r.friendCustomerId,
  friendName: r.friendName,
  friendEmail: r.friendEmail,
  channel: r.channel,
  status: r.status,
  statusLabel: REFERRAL_LABEL[r.status],
  orderId: r.orderId,
  orderNumber: orderNumber ?? null,
  spend: r.spend,
  spendMinor: r.spend,
  reward: r.reward,
  rewardMinor: r.reward,
  fraudScore: r.fraudScore,
  note: r.note,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
