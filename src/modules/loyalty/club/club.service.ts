/**
 * ASL Club: tiers (rolling 12-month spend), points earning on orders, rewards catalogue + redemption,
 * and the admin /club screen. The points engine (FIFO lots, expiry, liability journals) is points.service.ts.
 *
 * Earn: order.paid → floor((subtotal − discount) / (₦ nairaPerPoint)) × tier multiplier, available at once.
 * Refund / cancel → the same share of those points is taken back (capped at what's left to take).
 * Tiers: upgrade as soon as an order is paid; downgrades only happen in the nightly `club.recompute-tiers`.
 */
import crypto from "node:crypto";
import type { ClubReward, ClubTier, CustomerTier, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { auditDirect } from "@/core/middleware/audit";
import { logger } from "@/core/utils/logger";
import { env } from "@/config/env";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { customerBrief } from "@/modules/identity/auth/customer.mapper";
import { POINTS_ACC, pointsService as points } from "./points.service";
import { tierList, toAdminRedemption, toAdminReward, toHistoryRow, toLedgerRow, toRedemption, toTier } from "./club.mapper";
import type {
  AdjustBody, AdminRedemptionsQuery, HistoryQuery, LedgerQuery, RewardBody, RewardListQuery, RewardPatch, RulesBody, TierPatch,
} from "./club.schemas";

const DAY = 86_400_000;
const PAID_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
const brief = { ...customerBrief, tier: true } as const;

// ── tiers ──

async function activeTiers(db: Tx | typeof prisma = prisma) {
  const tiers = await db.clubTier.findMany({ where: { active: true }, orderBy: [{ minSpend: "asc" }, { position: "asc" }] });
  return tiers;
}

/** highest active tier whose rolling spend threshold is met (Standard as the floor) */
function tierFor(tiers: ClubTier[], spend: bigint | number): CustomerTier {
  let id: CustomerTier = "Standard";
  for (const t of tiers) if (BigInt(spend) >= t.minSpend) id = t.id;
  return id;
}

const rank = (tiers: ClubTier[], id: CustomerTier) => {
  const i = tiers.findIndex((t) => t.id === id);
  return i < 0 ? 0 : i;
};

const tierNames = (ids: CustomerTier[]) => (ids.length <= 1 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

async function changeTier(customerId: string, from: CustomerTier, to: CustomerTier, why: string) {
  await prisma.customer.update({ where: { id: customerId }, data: { tier: to } });
  await auditDirect({
    actorName: "ASL Club", actorEmail: "system", actorRole: "system", action: "club.tier_changed", category: "marketing",
    entity: "customer", entityId: customerId, summary: `Tier ${from} → ${to} (${why})`,
  });
  const tiers = await prisma.clubTier.findMany({ orderBy: [{ minSpend: "asc" }, { position: "asc" }] });
  const up = rank(tiers, to) > rank(tiers, from);
  if (!up) return;
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, firstName: true, deletedAt: true } });
  if (!c || c.deletedAt) return;
  const vars = { firstName: c.firstName || "there", tier: to, url: `${env.WEB_URL}/account/benefits` };
  await messaging.push(customerId, "club.tier_upgraded", vars, { type: "club", tier: to });
  await messaging.email(c.email, "club.tier_upgraded", vars);
}

/** after an order is paid: move up straight away if the rolling spend crossed a threshold */
async function upgradeIfDue(customerId: string) {
  const [c, stats, tiers] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId }, select: { tier: true } }),
    prisma.customerStats.findUnique({ where: { customerId }, select: { spend12m: true } }),
    activeTiers(),
  ]);
  if (!c || !stats) return null;
  const target = tierFor(tiers, stats.spend12m);
  if (rank(tiers, target) > rank(tiers, c.tier)) {
    await changeTier(customerId, c.tier, target, "spend threshold reached");
    return target;
  }
  return null;
}

/**
 * nightly: rebuild the rolling 12-month spend from paid orders (net of refunds) and set every
 * customer's tier from it — this is where downgrades happen.
 */
async function recomputeTiers(now = new Date()) {
  const since = new Date(now.getTime() - 365 * DAY);
  const sums = await prisma.order.groupBy({
    by: ["customerId"],
    where: { customerId: { not: null }, paidAt: { gte: since }, paymentStatus: { in: [...PAID_STATUSES] } },
    _sum: { amountPaid: true, amountRefunded: true },
  });
  const spend = new Map(sums.map((s) => [s.customerId!, Math.max(0, (s._sum.amountPaid ?? 0) - (s._sum.amountRefunded ?? 0))]));
  const tiers = await activeTiers();
  let changed = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.customer.findMany({
      where: { deletedAt: null },
      select: { id: true, tier: true, stats: { select: { spend12m: true } } },
      orderBy: { id: "asc" },
      take: 500,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!batch.length) break;
    for (const c of batch) {
      const s = spend.get(c.id) ?? 0;
      if (!c.stats || Number(c.stats.spend12m) !== s)
        await prisma.customerStats.upsert({ where: { customerId: c.id }, create: { customerId: c.id, spend12m: BigInt(s) }, update: { spend12m: BigInt(s) } });
      const target = tierFor(tiers, s);
      if (target !== c.tier) {
        await changeTier(c.id, c.tier, target, "nightly review of 12-month spend");
        changed++;
      }
    }
    cursor = batch[batch.length - 1].id;
  }
  return { changed };
}

// ── earning on orders ──

async function earnForOrder(orderId: string) {
  const club = await settingsService.get("club");
  if (!club.enabled) return null;
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, customerId: true, subtotal: true, discount: true, paymentStatus: true, customer: { select: { tier: true, deletedAt: true } } },
  });
  if (!o?.customerId || !o.customer || o.customer.deletedAt || o.paymentStatus !== "paid") return null;
  const tier = await prisma.clubTier.findUnique({ where: { id: o.customer.tier } });
  const base = Math.floor(Math.max(0, o.subtotal - o.discount) / (club.nairaPerPoint * 100));
  const earned = Math.floor((base * (tier?.multiplierX100 ?? 100)) / 100);
  const entry = await prisma.$transaction(async (tx) => {
    await points.lockCustomer(tx, o.customerId!);
    const done = await tx.pointsEntry.findFirst({ where: { customerId: o.customerId!, refType: "order", refId: o.id }, select: { id: true } });
    if (done) return null;
    return points.credit(tx, o.customerId!, earned, { kind: "order", refId: o.id, reason: `Order ${o.number} · earned${tier && tier.multiplierX100 !== 100 ? ` (${tier.multiplierX100 / 100}× ${tier.name})` : ""}` });
  });
  await points.journal([entry]);
  return entry;
}

/** refund / cancel: take back the refunded share of the points that order earned */
async function reverseForOrder(orderId: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, customerId: true, status: true, amountPaid: true, amountRefunded: true } });
  if (!o?.customerId || o.amountRefunded <= 0) return null;
  const entry = await prisma.$transaction(async (tx) => {
    await points.lockCustomer(tx, o.customerId!);
    const rows = await tx.pointsEntry.findMany({ where: { customerId: o.customerId!, refId: o.id, refType: { in: ["order", "order_reversal"] } }, select: { delta: true, refType: true } });
    const earned = rows.filter((r) => r.refType === "order").reduce((n, r) => n + r.delta, 0);
    const reversed = -rows.filter((r) => r.refType === "order_reversal").reduce((n, r) => n + r.delta, 0);
    if (earned <= 0) return null;
    const share = o.status === "cancelled" || o.amountPaid <= 0 ? 1 : Math.min(1, o.amountRefunded / o.amountPaid);
    const due = Math.round(earned * share) - reversed;
    if (due <= 0) return null;
    return points.debit(tx, o.customerId!, due, { kind: "order_reversal", refId: o.id, reason: `Order ${o.number} ${o.status === "cancelled" ? "cancelled" : "refunded"} · points reversed` }, { cap: true });
  });
  await points.journal([entry]);
  return entry;
}

// ── rewards ──

const COUPON_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
async function mintCode(tx: Tx, prefix: string) {
  for (let i = 0; i < 10; i++) {
    const tail = Array.from(crypto.randomBytes(5), (b) => COUPON_CHARS[b % COUPON_CHARS.length]).join("");
    const code = `${prefix}${tail}`;
    const clash = (await tx.customerCoupon.findUnique({ where: { code } })) || (await tx.coupon.findUnique({ where: { code } }));
    if (!clash) return code;
  }
  throw new Error("could not mint a unique coupon code");
}

/** personal single-use code (rewards, referrals) */
export async function mintCustomerCoupon(
  tx: Tx,
  customerId: string,
  c: { prefix: string; label: string; type: "percent" | "fixed" | "free_shipping"; value: number; source: "rewards" | "referral" | "promo"; days: number },
) {
  const code = await mintCode(tx, c.prefix);
  return tx.customerCoupon.create({
    data: { customerId, code, label: c.label, type: c.type, value: c.value, source: c.source, expiresAt: new Date(Date.now() + c.days * DAY) },
  });
}

/** Dr 2300 (points released) / Cr 2000 wallet credit or Cr 5300 — the difference lands on 5300 */
async function journalRedemption(redemptionId: string, pts: number, credit: number, title: string) {
  const { pointValueKobo } = await settingsService.get("club");
  const liability = pts * pointValueKobo;
  if (!liability && !credit) return;
  const lines: { accountCode: string; debit: number; credit: number; memo?: string }[] = [];
  if (liability) lines.push({ accountCode: POINTS_ACC.liability, debit: liability, credit: 0, memo: `${pts} pts redeemed` });
  if (credit) lines.push({ accountCode: POINTS_ACC.wallets, debit: 0, credit, memo: "Reward credit to wallet" });
  const diff = liability - credit;
  if (diff > 0) lines.push({ accountCode: POINTS_ACC.rewards, debit: 0, credit: diff, memo: credit ? "Points value above credit" : "Reward cost recognised" });
  if (diff < 0) lines.push({ accountCode: POINTS_ACC.rewards, debit: -diff, credit: 0, memo: "Credit above points value" });
  try {
    await ledgerService.postOnce("adjustment", `RDM-${redemptionId}`, { description: `Loyalty reward redeemed · ${title}`.slice(0, 190), createdBy: SYSTEM_USER, lines });
  } catch (err) {
    logger.error({ err, redemptionId }, "ledger: redemption journal failed");
  }
}

function lockedReason(r: ClubReward, tier: CustomerTier, balance: number) {
  const tiers = tierList(r.eligibleTiers);
  if (!tiers.includes(tier)) return `For ${tierNames(tiers)} members`;
  if (r.stock !== null && r.stock <= 0) return "Out of stock";
  if (balance < r.cost) return `${(r.cost - balance).toLocaleString("en-NG")} more points needed`;
  return null;
}

async function customerOrThrow(customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { ...brief, createdAt: true } });
  if (!c) throw ApiError.notFound("Customer");
  return c;
}

/** the account header card / rewards page / benefits page */
async function summaryFor(customerId: string) {
  const [c, stats, tiers, club, balance, wallet] = await Promise.all([
    customerOrThrow(customerId),
    prisma.customerStats.findUnique({ where: { customerId }, select: { spend12m: true } }),
    activeTiers(),
    settingsService.get("club"),
    points.available(prisma, customerId),
    walletsService.balanceOf(customerId),
  ]);
  const now = new Date();
  const soon = new Date(now.getTime() + club.expiringSoonDays * DAY);
  const [expiring, earned, spent] = await Promise.all([
    prisma.pointsEntry.aggregate({ where: { customerId, remaining: { gt: 0 }, expiresAt: { gt: now, lte: soon } }, _sum: { remaining: true }, _min: { expiresAt: true } }),
    prisma.pointsEntry.aggregate({ where: { customerId, delta: { gt: 0 } }, _sum: { delta: true } }),
    prisma.pointsEntry.aggregate({ where: { customerId, refType: "redemption" }, _sum: { delta: true } }),
  ]);
  const spend12m = Number(stats?.spend12m ?? 0);
  const current = tiers.find((t) => t.id === c.tier) ?? (await prisma.clubTier.findUnique({ where: { id: c.tier } })) ?? tiers[0];
  const next = tiers.find((t) => t.minSpend > (current?.minSpend ?? 0n)) ?? null;
  const from = Number(current?.minSpend ?? 0);
  const to = next ? Number(next.minSpend) : null;
  return {
    points: balance,
    pointsValue: balance * club.pointValueKobo,
    credit: wallet.balance,
    tier: current ? toTier(current) : null,
    multiplier: (current?.multiplierX100 ?? 100) / 100,
    perks: (current?.perks as string[]) ?? [],
    nextTier: next ? { id: next.id, name: next.name, minSpend: Number(next.minSpend), multiplier: next.multiplierX100 / 100 } : null,
    spend12m,
    spendToNext: to !== null ? Math.max(0, to - spend12m) : 0,
    progressPct: to !== null && to > from ? Math.max(0, Math.min(100, Math.round(((spend12m - from) / (to - from)) * 100))) : 100,
    tiers: tiers.map((t) => ({ ...toTier(t), current: t.id === c.tier, reached: t.minSpend <= (current?.minSpend ?? 0n) })),
    expiringSoon: { points: expiring._sum.remaining ?? 0, firstAt: expiring._min.expiresAt ?? null, withinDays: club.expiringSoonDays },
    lifetimeEarned: earned._sum.delta ?? 0,
    lifetimeRedeemed: -(spent._sum.delta ?? 0),
    memberSince: c.createdAt,
    rules: { nairaPerPoint: club.nairaPerPoint, pointValueKobo: club.pointValueKobo, expiryMonths: club.expiryMonths, enabled: club.enabled },
  };
}

const redemptionInclude = { reward: { select: { id: true, title: true, category: true } } } as const;

export const clubService = {
  tierFor,
  recomputeTiers,
  upgradeIfDue,
  earnForOrder,
  reverseForOrder,

  /** order.paid: earn at the tier the customer had when buying, then upgrade if the spend crossed a threshold */
  async onOrderPaid(orderId: string) {
    const entry = await earnForOrder(orderId);
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
    if (o?.customerId) await upgradeIfDue(o.customerId);
    return entry;
  },

  // ── customer /store/me/club ──
  summary: summaryFor,

  async history(customerId: string, q: HistoryQuery) {
    const where: Prisma.PointsEntryWhereInput = { customerId, ...(q.type === "earned" ? { delta: { gt: 0 } } : q.type === "spent" ? { delta: { lt: 0 } } : {}) };
    const [rows, total] = await Promise.all([
      prisma.pointsEntry.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging(q) }),
      prisma.pointsEntry.count({ where }),
    ]);
    return withMeta(rows.map(toHistoryRow), pageMeta(q, total));
  },

  async rewards(customerId: string) {
    const [c, balance, rows] = await Promise.all([
      customerOrThrow(customerId),
      points.available(prisma, customerId),
      prisma.clubReward.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { cost: "asc" }] }),
    ]);
    const data = rows.map((r) => {
      const why = lockedReason(r, c.tier, balance);
      return {
        id: r.id, title: r.title, description: r.description, cost: r.cost, category: r.category, value: r.value, icon: r.icon,
        eligibleTiers: tierList(r.eligibleTiers), stock: r.stock,
        eligible: tierList(r.eligibleTiers).includes(c.tier), canRedeem: !why, lockedReason: why,
      };
    });
    return withMeta(data, { points: balance, tier: c.tier });
  },

  async redeem(customerId: string, rewardId: string) {
    const c = await customerOrThrow(customerId);
    const club = await settingsService.get("club");
    if (!club.enabled) throw ApiError.conflict("INVALID_STATE", "ASL Club rewards are paused right now.");
    const reward = await prisma.clubReward.findUnique({ where: { id: rewardId } });
    if (!reward || !reward.active) throw ApiError.notFound("Reward");
    const tiers = tierList(reward.eligibleTiers);
    if (!tiers.includes(c.tier)) throw ApiError.badRequest("INVALID_STATE", `This reward is for ${tierNames(tiers)} members.`);

    let walletTxId: string | null = null;
    let couponCode: string | null = null;
    const r = await prisma.$transaction(async (tx) => {
      await points.lockCustomer(tx, customerId);
      await points.consume(tx, customerId, reward.cost); // INSUFFICIENT_POINTS
      if (reward.stock !== null) {
        const u = await tx.clubReward.updateMany({ where: { id: reward.id, stock: { gt: 0 } }, data: { stock: { decrement: 1 }, redeemedCount: { increment: 1 } } });
        if (!u.count) throw ApiError.conflict("OUT_OF_STOCK", "This reward is no longer available.");
      } else await tx.clubReward.update({ where: { id: reward.id }, data: { redeemedCount: { increment: 1 } } });

      const red = await tx.rewardRedemption.create({ data: { rewardId: reward.id, customerId, points: reward.cost, result: {}, status: "pending" } });
      await tx.pointsEntry.create({
        data: { customerId, delta: -reward.cost, remaining: 0, reason: `Redeemed: ${reward.title}`, refType: "redemption", refId: red.id },
      });

      let result: Prisma.InputJsonValue = { note: "Our team will be in touch to arrange this reward." };
      let status = "pending";
      if (reward.category === "coupon") {
        const pct = Math.min(100, Math.max(1, reward.value ?? 10));
        const cc = await mintCustomerCoupon(tx, customerId, { prefix: `ASL${pct}`, label: reward.title, type: "percent", value: pct, source: "rewards", days: club.rewardCouponDays });
        couponCode = cc.code;
        result = { couponCode: cc.code, expiresAt: cc.expiresAt?.toISOString() ?? null };
        status = "fulfilled";
      } else if (reward.category === "shipping") {
        const cc = await mintCustomerCoupon(tx, customerId, { prefix: "SHIP", label: reward.title, type: "free_shipping", value: 0, source: "rewards", days: club.rewardCouponDays });
        couponCode = cc.code;
        result = { couponCode: cc.code, expiresAt: cc.expiresAt?.toISOString() ?? null };
        status = "fulfilled";
      } else if (reward.category === "credit") {
        const amount = reward.value ?? 0;
        if (amount <= 0) throw ApiError.conflict("INVALID_STATE", "This reward isn't set up correctly. Please contact support.");
        const t = await walletsService.post(tx, customerId, {
          kind: "credit", amount, title: reward.title, subtitle: "ASL Club reward", channel: "system", meta: { redemptionId: red.id },
        });
        walletTxId = t.id;
        result = { walletTxRef: t.reference, amount };
        status = "fulfilled";
      }
      return tx.rewardRedemption.update({ where: { id: red.id }, data: { status, result }, include: redemptionInclude });
    });

    await journalRedemption(r.id, reward.cost, reward.category === "credit" ? (reward.value ?? 0) : 0, reward.title);
    if (walletTxId) events.emit("wallet.changed", { customerId });
    if (couponCode) events.emit("coupon.minted", { customerId, code: couponCode });
    return { redemption: toRedemption(r), points: await points.available(prisma, customerId) };
  },

  async myRedemptions(customerId: string, q: { page: number; pageSize: number }) {
    const where = { customerId };
    const [rows, total] = await Promise.all([
      prisma.rewardRedemption.findMany({ where, include: redemptionInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.rewardRedemption.count({ where }),
    ]);
    return withMeta(rows.map(toRedemption), pageMeta(q, total));
  },

  // ── admin /club ──
  async overview() {
    const club = await settingsService.get("club");
    const [tiers, members, byTier, outstanding, rewards, pendingRedemptions] = await Promise.all([
      prisma.clubTier.findMany({ orderBy: [{ position: "asc" }] }),
      prisma.customer.count({ where: { deletedAt: null } }),
      prisma.customer.groupBy({ by: ["tier"], where: { deletedAt: null }, _count: { _all: true } }),
      prisma.pointsEntry.aggregate({ where: { remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, _sum: { remaining: true } }),
      prisma.clubReward.findMany({ select: { active: true, redeemedCount: true } }),
      prisma.rewardRedemption.count({ where: { status: "pending" } }),
    ]);
    const spendByTier = await Promise.all(
      tiers.map(async (t) => [t.id, Number((await prisma.customerStats.aggregate({ where: { customer: { tier: t.id, deletedAt: null } }, _sum: { totalSpend: true } }))._sum.totalSpend ?? 0)] as const),
    );
    const count = (id: CustomerTier) => byTier.find((g) => g.tier === id)?._count._all ?? 0;
    const pointsOutstanding = outstanding._sum.remaining ?? 0;
    return {
      kpis: {
        members,
        vipMembers: count("Gold") + count("Signature"),
        pointsOutstanding,
        liability: pointsOutstanding * club.pointValueKobo,
        rewards: rewards.length,
        liveRewards: rewards.filter((r) => r.active).length,
        redeemed: rewards.reduce((n, r) => n + r.redeemedCount, 0),
        pendingRedemptions,
      },
      tiers: tiers.map((t) => ({ ...toTier(t), memberCount: count(t.id), spendTotal: spendByTier.find(([id]) => id === t.id)?.[1] ?? 0 })),
      rules: club,
    };
  },

  async tiers() {
    return (await prisma.clubTier.findMany({ orderBy: { position: "asc" } })).map(toTier);
  },

  async updateTier(id: CustomerTier, b: TierPatch) {
    const t = await prisma.clubTier.findUnique({ where: { id } });
    if (!t) throw ApiError.notFound("Tier");
    if (id === "Standard" && b.minSpend !== undefined && b.minSpend !== 0) throw ApiError.badRequest("VALIDATION_FAILED", "Standard is the entry tier: its minimum spend stays ₦0.");
    if (id === "Standard" && b.active === false) throw ApiError.badRequest("VALIDATION_FAILED", "Standard is the entry tier and can't be switched off.");
    const after = await prisma.clubTier.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.color !== undefined ? { color: b.color } : {}),
        ...(b.minSpend !== undefined ? { minSpend: BigInt(b.minSpend) } : {}),
        ...(b.multiplier !== undefined ? { multiplierX100: Math.round(b.multiplier * 100) } : {}),
        ...(b.perks !== undefined ? { perks: b.perks } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    settingsService.clearCache();
    return { before: toTier(t), after: toTier(after) };
  },

  rules: () => settingsService.get("club"),
  updateRules: (b: RulesBody, by: string) => settingsService.update("club", b, by),

  async adminRewards(q: RewardListQuery) {
    const where: Prisma.ClubRewardWhereInput = {
      ...(q.category ? { category: q.category } : {}),
      ...(q.active !== undefined ? { active: q.active } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { description: { contains: q.q } }] } : {}),
    };
    const [rows, total, cats] = await Promise.all([
      prisma.clubReward.findMany({ where, orderBy: [{ position: "asc" }, { createdAt: "desc" }], ...paging(q) }),
      prisma.clubReward.count({ where }),
      prisma.clubReward.groupBy({ by: ["category"], _count: { _all: true } }),
    ]);
    const tabs: Record<string, number> = { all: cats.reduce((n, c) => n + c._count._all, 0) };
    for (const c of cats) tabs[c.category] = c._count._all;
    return withMeta(rows.map(toAdminReward), { ...pageMeta(q, total), tabs });
  },

  async getReward(id: string) {
    const r = await prisma.clubReward.findUnique({ where: { id } });
    if (!r) throw ApiError.notFound("Reward");
    return toAdminReward(r);
  },

  async createReward(b: RewardBody) {
    const last = await prisma.clubReward.aggregate({ _max: { position: true } });
    const r = await prisma.clubReward.create({
      data: { ...b, value: b.value ?? null, icon: b.icon ?? null, stock: b.stock ?? null, eligibleTiers: b.eligibleTiers, position: (last._max.position ?? -1) + 1 },
    });
    return toAdminReward(r);
  },

  async updateReward(id: string, b: RewardPatch) {
    const before = await this.getReward(id);
    const r = await prisma.clubReward.update({ where: { id }, data: { ...b, ...(b.eligibleTiers ? { eligibleTiers: b.eligibleTiers } : {}) } });
    return { before, after: toAdminReward(r) };
  },

  async duplicateReward(id: string) {
    const src = await prisma.clubReward.findUnique({ where: { id } });
    if (!src) throw ApiError.notFound("Reward");
    const last = await prisma.clubReward.aggregate({ _max: { position: true } });
    const r = await prisma.clubReward.create({
      data: {
        title: `${src.title} (copy)`, description: src.description, cost: src.cost, category: src.category, value: src.value, icon: src.icon,
        eligibleTiers: src.eligibleTiers as Prisma.InputJsonValue, stock: src.stock, active: false, position: (last._max.position ?? -1) + 1,
      },
    });
    return toAdminReward(r);
  },

  async toggleReward(id: string) {
    const r = await prisma.clubReward.findUnique({ where: { id } });
    if (!r) throw ApiError.notFound("Reward");
    return toAdminReward(await prisma.clubReward.update({ where: { id }, data: { active: !r.active } }));
  },

  /** ids in display order; rewards not listed keep their relative order after them */
  async reorderRewards(ids: string[]) {
    const current = await prisma.clubReward.findMany({ select: { id: true }, orderBy: [{ position: "asc" }, { createdAt: "desc" }] });
    const known = new Set(current.map((r) => r.id));
    const listed = [...new Set(ids)].filter((id) => known.has(id));
    const order = [...listed, ...current.map((r) => r.id).filter((id) => !listed.includes(id))];
    await prisma.$transaction(order.map((id, position) => prisma.clubReward.update({ where: { id }, data: { position } })));
    return (await prisma.clubReward.findMany({ orderBy: [{ position: "asc" }, { createdAt: "desc" }] })).map(toAdminReward);
  },

  async removeReward(id: string) {
    const r = await prisma.clubReward.findUnique({ where: { id }, include: { _count: { select: { redemptions: true } } } });
    if (!r) throw ApiError.notFound("Reward");
    if (r._count.redemptions) throw ApiError.conflict("INVALID_STATE", "Customers have redeemed this reward, so it is kept for their history. Switch it off instead.");
    await prisma.clubReward.delete({ where: { id } });
    return { deleted: true, before: toAdminReward(r) };
  },

  async adjust(b: AdjustBody, actor: string) {
    await customerOrThrow(b.customerId);
    const e = await points.apply(b.customerId, b.delta, { kind: "adjustment", reason: b.reason, actor });
    return { entryId: e?.id ?? null, customerId: b.customerId, delta: b.delta, points: await points.available(prisma, b.customerId) };
  },

  async ledger(q: LedgerQuery) {
    const where: Prisma.PointsEntryWhereInput = {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.type === "earned" ? { delta: { gt: 0 } } : q.type === "spent" ? { delta: { lt: 0 } } : {}),
      ...(q.kind ? { refType: q.kind } : {}),
      ...(q.q
        ? { OR: [{ reason: { contains: q.q } }, { customer: { email: { contains: q.q } } }, { customer: { firstName: { contains: q.q } } }, { customer: { lastName: { contains: q.q } } }] }
        : {}),
    };
    const [rows, total, sums] = await Promise.all([
      prisma.pointsEntry.findMany({ where, include: { customer: { select: brief } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging(q) }),
      prisma.pointsEntry.count({ where }),
      Promise.all([
        prisma.pointsEntry.aggregate({ where: { ...where, delta: { gt: 0 } }, _sum: { delta: true } }),
        prisma.pointsEntry.aggregate({ where: { ...where, delta: { lt: 0 } }, _sum: { delta: true } }),
      ]),
    ]);
    return withMeta(rows.map(toLedgerRow), { ...pageMeta(q, total), kpis: { issued: sums[0]._sum.delta ?? 0, spent: -(sums[1]._sum.delta ?? 0) } });
  },

  async customerSummary(customerId: string) {
    return summaryFor(customerId);
  },

  async adminRedemptions(q: AdminRedemptionsQuery) {
    const base: Prisma.RewardRedemptionWhereInput = {
      ...(q.category ? { reward: { category: q.category } } : {}),
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.q ? { OR: [{ reward: { title: { contains: q.q } } }, { customer: { email: { contains: q.q } } }, { customer: { lastName: { contains: q.q } } }] } : {}),
    };
    const where = { ...base, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.rewardRedemption.findMany({ where, include: { ...redemptionInclude, customer: { select: brief } }, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.rewardRedemption.count({ where }),
      prisma.rewardRedemption.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    ]);
    const tabs: Record<string, number> = { all: 0, pending: 0, fulfilled: 0, cancelled: 0 };
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    return withMeta(rows.map(toAdminRedemption), { ...pageMeta(q, total), tabs });
  },

  async fulfilRedemption(id: string, note: string | undefined, actor: string) {
    const r = await prisma.rewardRedemption.findUnique({ where: { id }, include: { ...redemptionInclude, customer: { select: brief } } });
    if (!r) throw ApiError.notFound("Redemption");
    if (r.status !== "pending") throw ApiError.conflict("INVALID_STATE", `This redemption is already ${r.status}.`);
    const result = { ...((r.result as object) ?? {}), note: note || (r.result as { note?: string })?.note, fulfilledBy: actor, fulfilledAt: new Date().toISOString() };
    const after = await prisma.rewardRedemption.update({ where: { id }, data: { status: "fulfilled", result }, include: { ...redemptionInclude, customer: { select: brief } } });
    return { before: toAdminRedemption(r), after: toAdminRedemption(after) };
  },

  /** cancel → points back (as a fresh lot) and stock back. Wallet credits and used codes can't be undone here. */
  async cancelRedemption(id: string, reason: string, actor: string) {
    const r = await prisma.rewardRedemption.findUnique({ where: { id }, include: { reward: true, customer: { select: brief } } });
    if (!r) throw ApiError.notFound("Redemption");
    if (r.status === "cancelled") throw ApiError.conflict("INVALID_STATE", "This redemption is already cancelled.");
    const res = (r.result ?? {}) as { couponCode?: string; walletTxRef?: string };
    if (res.walletTxRef) throw ApiError.conflict("INVALID_STATE", "The credit is already in the customer's wallet. Reverse that wallet transaction instead.");
    const entry = await prisma.$transaction(async (tx) => {
      await points.lockCustomer(tx, r.customerId);
      if (res.couponCode) {
        const cc = await tx.customerCoupon.findUnique({ where: { code: res.couponCode } });
        if (cc?.usedAt) throw ApiError.conflict("INVALID_STATE", `Code ${cc.code} has already been used on an order.`);
        if (cc) await tx.customerCoupon.update({ where: { id: cc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      }
      const u = await tx.rewardRedemption.updateMany({ where: { id, status: { not: "cancelled" } }, data: { status: "cancelled", result: { ...(r.result as object), cancelledBy: actor, reason } } });
      if (!u.count) throw ApiError.conflict("INVALID_STATE", "This redemption is already cancelled.");
      await tx.clubReward.update({
        where: { id: r.rewardId },
        data: { redeemedCount: { decrement: r.reward.redeemedCount > 0 ? 1 : 0 }, ...(r.reward.stock !== null ? { stock: { increment: 1 } } : {}) },
      });
      return points.credit(tx, r.customerId, r.points, { kind: "redemption_refund", refId: r.id, reason: `Refund: ${r.reward.title} — ${reason}`, actor });
    });
    await points.journal([entry]);
    const after = await prisma.rewardRedemption.findUniqueOrThrow({ where: { id }, include: { ...redemptionInclude, customer: { select: brief } } });
    return { after: toAdminRedemption(after) };
  },

  // ── bonuses ──
  async signupBonus(customerId: string) {
    const club = await settingsService.get("club");
    if (!club.enabled || !club.signupBonus) return null;
    return points.apply(customerId, club.signupBonus, { kind: "signup", refId: customerId, reason: "Welcome to ASL Club" }, { once: true });
  },

  async reviewBonus(reviewId: string) {
    const club = await settingsService.get("club");
    if (!club.enabled || !club.reviewBonus) return null;
    const r = await prisma.review.findUnique({ where: { id: reviewId }, select: { customerId: true, product: { select: { name: true } } } });
    if (!r?.customerId) return null;
    return points.apply(r.customerId, club.reviewBonus, { kind: "review", refId: reviewId, reason: `Review of ${r.product.name}` }, { once: true });
  },

  async birthdayBonuses(now = new Date()) {
    const club = await settingsService.get("club");
    if (!club.enabled || !club.birthdayBonus) return { awarded: 0 };
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM \`Customer\` WHERE deletedAt IS NULL AND dateOfBirth IS NOT NULL
      AND MONTH(dateOfBirth) = ${now.getMonth() + 1} AND DAY(dateOfBirth) = ${now.getDate()}`;
    let awarded = 0;
    for (const { id } of rows) {
      const e = await points.apply(id, club.birthdayBonus, { kind: "birthday", refId: `${id}-${now.getFullYear()}`, reason: `Happy birthday! ${now.getFullYear()} bonus` }, { once: true });
      if (e) awarded++;
    }
    return { awarded };
  },
};

export const recomputeTiersJob = defineJob("club.recompute-tiers", async () => {
  const r = await recomputeTiers();
  logger.info(r, "club: tiers recomputed");
});
export const expirePointsJob = defineJob("club.expire-points", async () => {
  const r = await points.expireDue();
  if (r.points) logger.info(r, "club: points expired");
});
export const birthdayBonusJob = defineJob("club.birthday-bonus", async () => {
  await clubService.birthdayBonuses();
});

