/**
 * Referral programme. Every customer is an advocate with a personal code (created at registration).
 *
 *   sign-up with a code → Referral "pending" (+ the friend's welcome reward, e.g. a 10% personal code)
 *                         self-referrals are "rejected"; suspicious ones "flagged" (no reward until approved)
 *   friend's first paid order ≥ qualifyingSpend → the order is attached (still pending)
 *   job `referrals.qualify` → once the order is delivered and the return window has passed without a
 *                             refund: "qualified", then "rewarded" (advocate gets credit / points / a code)
 * Wallet credits post `wallet.posted` so the ledger books them as Dr 5300 / Cr 2000.
 */
import type { Advocate, Customer, PointsEntry, Prisma, Referral } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { formatNaira } from "@/core/utils/money";
import { randomToken } from "@/core/auth/tokens";
import { env } from "@/config/env";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { pointsService } from "@/modules/loyalty/club/points.service";
import { mintCustomerCoupon } from "@/modules/loyalty/club/club.service";
import { REFERRAL_LABEL, rewardLabel, toAdminReferral, toFriend, type RewardSpec } from "./referrals.mapper";
import type { AdvocateListQuery, ConfigBody, ReferralListQuery } from "./referrals.schemas";

const DAY = 86_400_000;
type Config = SettingsOf<"referrals">;
const advocateInclude = { advocate: { include: { customer: { select: { id: true, firstName: true, lastName: true, email: true } } } } } as const;

// ── fraud checks ──

const FREE_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "live.com", "aol.com", "proton.me", "protonmail.com", "ymail.com", "mail.com"]);

/** john.doe+promo@googlemail.com → johndoe@gmail.com */
export function normalizeEmail(email: string) {
  const [rawLocal, rawDomain = ""] = email.trim().toLowerCase().split("@");
  const domain = rawDomain === "googlemail.com" ? "gmail.com" : rawDomain;
  let local = rawLocal.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return { email: `${local}@${domain}`, domain };
}
const digits = (p: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
const same = (a: string, b: string) => !!a.trim() && a.trim().toLowerCase() === b.trim().toLowerCase();

type Person = Pick<Customer, "id" | "email" | "firstName" | "lastName" | "phone">;

/** 100 = the same person (blocked); otherwise a 0–100 risk score */
export function fraudCheck(advocate: Person, friend: Person) {
  const a = normalizeEmail(advocate.email);
  const f = normalizeEmail(friend.email);
  if (advocate.id === friend.id || a.email === f.email) return { self: true, score: 100, reasons: ["Same email address"] };
  if (digits(advocate.phone).length >= 7 && digits(advocate.phone) === digits(friend.phone)) return { self: true, score: 100, reasons: ["Same phone number"] };
  let score = 0;
  const reasons: string[] = [];
  if (same(advocate.firstName, friend.firstName) && same(advocate.lastName, friend.lastName)) {
    score += 50;
    reasons.push("Same name");
  } else if (same(advocate.lastName, friend.lastName)) {
    score += 20;
    reasons.push("Same surname");
  }
  if (a.domain === f.domain && !FREE_DOMAINS.has(a.domain)) {
    score += 25;
    reasons.push(`Same email domain (${a.domain})`);
  }
  return { self: false, score: Math.min(99, score), reasons };
}

// ── helpers ──

async function uniqueCode(firstName: string) {
  const base = (firstName.replace(/[^a-z]/gi, "").toUpperCase() || "ASL").slice(0, 8);
  for (let i = 0; i < 10; i++) {
    const code = `${base}-ASL${Math.floor(10 + Math.random() * 90)}`;
    if (!(await prisma.advocate.findUnique({ where: { code } })) && !(await prisma.customer.findUnique({ where: { referralCode: code } }))) return code;
  }
  return `${base}-${randomToken(4).toUpperCase()}`;
}

/** customers created before the programme (seed, imports) get their advocate row on first visit */
async function ensureAdvocate(customerId: string) {
  const existing = await prisma.advocate.findUnique({ where: { customerId } });
  if (existing) return existing;
  const c = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null } });
  if (!c) throw ApiError.notFound("Customer");
  const code = c.referralCode ?? (await uniqueCode(c.firstName));
  try {
    if (!c.referralCode) await prisma.customer.update({ where: { id: c.id }, data: { referralCode: code } });
    return await prisma.advocate.create({ data: { customerId: c.id, code } });
  } catch {
    return prisma.advocate.findUniqueOrThrow({ where: { customerId } });
  }
}

async function activeAdvocateByCode(code: string) {
  const a = await prisma.advocate.findUnique({ where: { code: code.trim().toUpperCase() }, include: { customer: { select: { firstName: true, deletedAt: true } } } });
  if (!a || a.status !== "active" || a.customer.deletedAt) throw ApiError.notFound("Referral code");
  return a;
}

type Granted = { walletTxIds: string[]; entries: (PointsEntry | null)[]; coupons: string[] };
const granted = (): Granted => ({ walletTxIds: [], entries: [], coupons: [] });

/** give one side its reward inside the caller's transaction; returns the kobo value given */
async function give(tx: Tx, customerId: string, spec: RewardSpec, ctx: { referralId: string; who: "advocate" | "friend"; label: string; days: number }, out: Granted) {
  if (spec.value <= 0) return 0;
  switch (spec.type) {
    case "credit": {
      const t = await walletsService.post(tx, customerId, {
        kind: "credit", amount: spec.value, title: ctx.who === "advocate" ? "Referral reward" : "Welcome gift", subtitle: ctx.label,
        channel: "system", meta: { referralId: ctx.referralId, side: ctx.who }, allowFrozen: true,
      });
      out.walletTxIds.push(t.id);
      return spec.value;
    }
    case "points": {
      const e = await pointsService.credit(tx, customerId, spec.value, { kind: "referral", refId: `${ctx.who}-${ctx.referralId}`, reason: ctx.label });
      out.entries.push(e);
      const { pointValueKobo } = await settingsService.get("club");
      return spec.value * pointValueKobo;
    }
    case "percent":
    case "fixed": {
      const cc = await mintCustomerCoupon(tx, customerId, {
        prefix: ctx.who === "friend" ? "WELCOME" : "REF", label: ctx.label, type: spec.type, value: spec.value, source: "referral", days: ctx.days,
      });
      out.coupons.push(cc.code);
      return spec.type === "fixed" ? spec.value : 0;
    }
  }
}

/** has the friend already had their welcome reward for this referral? */
async function friendRewarded(tx: Tx, r: Referral) {
  if (!r.friendCustomerId) return true;
  const [coupon, entry, wtx] = await Promise.all([
    tx.customerCoupon.findFirst({ where: { customerId: r.friendCustomerId, source: "referral" }, select: { id: true } }),
    tx.pointsEntry.findFirst({ where: { customerId: r.friendCustomerId, refType: "referral", refId: `friend-${r.id}` }, select: { id: true } }),
    tx.walletTransaction.findFirst({ where: { wallet: { customerId: r.friendCustomerId }, meta: { path: "$.referralId", equals: r.id } }, select: { id: true } }),
  ]);
  return !!(coupon || entry || wtx);
}

async function giveFriend(tx: Tx, r: Referral, advocateFirstName: string, cfg: Config, out: Granted) {
  if (!r.friendCustomerId || (await friendRewarded(tx, r))) return;
  await give(tx, r.friendCustomerId, cfg.friendReward, { referralId: r.id, who: "friend", label: `Welcome gift from ${advocateFirstName} · ${rewardLabel(cfg.friendReward, "friend").replace("their", "your")}`, days: cfg.friendCouponDays }, out);
}

async function afterGrant(out: Granted, notify: { customerId: string; code: string; vars: Record<string, string> }[] = []) {
  for (const id of out.walletTxIds) {
    const t = await prisma.walletTransaction.findUnique({ where: { id }, select: { wallet: { select: { customerId: true } } } });
    events.emit("wallet.posted", { txId: id });
    if (t) events.emit("wallet.changed", { customerId: t.wallet.customerId });
  }
  await pointsService.journal(out.entries);
  for (const n of notify) await messaging.push(n.customerId, n.code, n.vars, { type: "referral" });
}

/**
 * Reward the advocate (and the friend, if a flagged referral is being approved).
 * `manual`: an admin approved it → errors explain why it can't be rewarded; the job just skips.
 */
async function reward(referralId: string, actor: string, manual = false) {
  const cfg = await settingsService.get("referrals");
  const out = granted();
  let notify: { customerId: string; code: string; vars: Record<string, string> } | null = null;
  const done = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM \`Referral\` WHERE id = ${referralId} FOR UPDATE`;
    const r = await tx.referral.findUnique({ where: { id: referralId }, include: { advocate: { include: { customer: { select: { id: true, firstName: true, deletedAt: true } } } } } });
    if (!r) throw ApiError.notFound("Referral");
    const fail = (msg: string) => {
      if (manual) throw ApiError.conflict("INVALID_STATE", msg);
      return null;
    };
    if (r.status === "rewarded") return fail("This referral has already been rewarded.");
    if (!manual && r.status !== "qualified") return null;
    if (["rejected", "expired"].includes(r.status) && manual) return fail(`This referral is ${r.status}. Move it back to pending before approving.`);
    if (r.advocate.status !== "active" || r.advocate.customer.deletedAt) return fail(`The advocate is ${r.advocate.status === "active" ? "no longer a customer" : r.advocate.status}.`);
    if (cfg.maxRewardsPerAdvocate > 0) {
      const count = await tx.referral.count({ where: { advocateId: r.advocateId, status: "rewarded" } });
      if (count >= cfg.maxRewardsPerAdvocate) {
        if (!manual) await tx.referral.update({ where: { id: r.id }, data: { note: "Advocate reached the reward limit" } });
        return fail(`This advocate already has ${count} rewarded referrals (limit ${cfg.maxRewardsPerAdvocate}).`);
      }
    }
    if (cfg.advocateReward.type === "points") await pointsService.lockCustomer(tx, r.advocate.customerId);
    const label = `${r.friendName.split(" ")[0] || "Your friend"} made their first order`;
    const value = await give(tx, r.advocate.customerId, cfg.advocateReward, { referralId: r.id, who: "advocate", label, days: 90 }, out);
    await giveFriend(tx, r, r.advocate.customer.firstName, cfg, out);
    const note = manual ? [r.note, `Approved by ${actor}`].filter(Boolean).join(" · ") : r.note;
    notify = { customerId: r.advocate.customerId, code: "referral.rewarded", vars: { firstName: r.advocate.customer.firstName, friend: r.friendName.split(" ")[0] ?? "", reward: rewardLabel(cfg.advocateReward, "advocate") } };
    return tx.referral.update({ where: { id: r.id }, data: { status: "rewarded", reward: value, note } });
  });
  await afterGrant(out, notify ? [notify] : []);
  return done;
}

// ── counts for admin screens ──

async function advocateStats(advocateIds: string[]) {
  if (!advocateIds.length) return new Map<string, { signups: number; qualified: number; rewards: number; revenue: number }>();
  const [groups, friends] = await Promise.all([
    prisma.referral.groupBy({ by: ["advocateId", "status"], where: { advocateId: { in: advocateIds } }, _count: { _all: true }, _sum: { reward: true } }),
    prisma.referral.findMany({ where: { advocateId: { in: advocateIds }, friendCustomerId: { not: null }, status: { notIn: ["rejected"] } }, select: { advocateId: true, friendCustomerId: true } }),
  ]);
  const stats = await prisma.customerStats.findMany({ where: { customerId: { in: friends.map((f) => f.friendCustomerId!) } }, select: { customerId: true, totalSpend: true } });
  const spend = new Map(stats.map((s) => [s.customerId, Number(s.totalSpend)]));
  const out = new Map<string, { signups: number; qualified: number; rewards: number; revenue: number }>();
  for (const id of advocateIds) out.set(id, { signups: 0, qualified: 0, rewards: 0, revenue: 0 });
  for (const g of groups) {
    const s = out.get(g.advocateId)!;
    s.signups += g._count._all;
    if (g.status === "qualified" || g.status === "rewarded") s.qualified += g._count._all;
    if (g.status === "rewarded") s.rewards += g._sum.reward ?? 0;
  }
  for (const f of friends) out.get(f.advocateId)!.revenue += spend.get(f.friendCustomerId!) ?? 0;
  return out;
}

type AdvocateRow = Advocate & { customer: { id: string; firstName: string; lastName: string; email: string; tier: Customer["tier"] } };
const toAdvocate = (a: AdvocateRow, s = { signups: 0, qualified: 0, rewards: 0, revenue: 0 }) => ({
  id: a.id,
  customerId: a.customerId,
  name: fullName(a.customer),
  email: a.customer.email,
  tier: a.customer.tier,
  code: a.code,
  joinedAt: a.createdAt,
  clicks: a.clicks,
  signups: s.signups,
  qualified: s.qualified,
  rewardsEarnedMinor: s.rewards,
  revenueDrivenMinor: s.revenue,
  status: a.status,
});

export const referralsService = {
  ensureAdvocate,
  reward,

  // ── customer /store/me/referrals ──
  async mine(customerId: string) {
    const [adv, cfg] = await Promise.all([ensureAdvocate(customerId), settingsService.get("referrals")]);
    const [rows, groups] = await Promise.all([
      prisma.referral.findMany({ where: { advocateId: adv.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.referral.groupBy({ by: ["status"], where: { advocateId: adv.id }, _count: { _all: true }, _sum: { reward: true } }),
    ]);
    const n = (...s: string[]) => groups.filter((g) => s.includes(g.status)).reduce((x, g) => x + g._count._all, 0);
    return {
      enabled: cfg.enabled && adv.status === "active",
      status: adv.status,
      code: adv.code,
      link: `${env.WEB_URL}/r/${adv.code}`,
      headline: cfg.landingHeadline,
      subhead: cfg.landingSubhead,
      advocateReward: { ...cfg.advocateReward, label: rewardLabel(cfg.advocateReward, "advocate") },
      friendReward: { ...cfg.friendReward, label: rewardLabel(cfg.friendReward, "friend") },
      qualifyingSpend: cfg.qualifyingSpend,
      stats: {
        clicks: adv.clicks,
        invited: groups.reduce((x, g) => x + g._count._all, 0),
        joined: n("qualified", "rewarded"),
        pending: n("pending", "flagged"),
        earned: groups.find((g) => g.status === "rewarded")?._sum.reward ?? 0,
      },
      friends: rows.map(toFriend),
    };
  },

  /** share link landing (/r/:code) — counts the click */
  async click(code: string) {
    const [a, cfg] = await Promise.all([activeAdvocateByCode(code), settingsService.get("referrals")]);
    if (!cfg.enabled) throw ApiError.notFound("Referral code");
    await prisma.advocate.update({ where: { id: a.id }, data: { clicks: { increment: 1 } } });
    return this.landing(a.code, a.customer.firstName, cfg);
  },

  async lookup(code: string) {
    const [a, cfg] = await Promise.all([activeAdvocateByCode(code), settingsService.get("referrals")]);
    if (!cfg.enabled) throw ApiError.notFound("Referral code");
    return this.landing(a.code, a.customer.firstName, cfg);
  },

  landing(code: string, firstName: string, cfg: Config) {
    return {
      valid: true,
      code,
      advocateFirstName: firstName,
      headline: cfg.landingHeadline,
      subhead: cfg.landingSubhead,
      friendReward: { ...cfg.friendReward, label: rewardLabel(cfg.friendReward, "friend") },
      qualifyingSpend: cfg.qualifyingSpend,
      cookieWindowDays: cfg.cookieWindowDays,
    };
  },

  // ── lifecycle ──
  /** customer.registered with a code: create the referral and the friend's welcome reward */
  async onRegistered(customerId: string, code: string) {
    const cfg = await settingsService.get("referrals");
    if (!cfg.enabled) return null;
    const adv = await prisma.advocate.findUnique({ where: { code: code.trim().toUpperCase() }, include: { customer: true } });
    const friend = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!adv || adv.status !== "active" || !friend) return null;
    if (await prisma.referral.findUnique({ where: { friendCustomerId: customerId } })) return null;

    const check = fraudCheck(adv.customer, friend);
    const status = check.self ? "rejected" : check.score >= cfg.fraudScoreThreshold ? "flagged" : "pending";
    const note = check.self ? `Self-referral blocked (${check.reasons.join(", ")})` : check.reasons.length ? check.reasons.join(", ") : null;
    const out = granted();
    const r = await prisma.$transaction(async (tx) => {
      const r = await tx.referral.create({
        data: { advocateId: adv.id, friendCustomerId: friend.id, friendName: fullName(friend), friendEmail: friend.email, status, fraudScore: check.score, note },
      });
      if (status === "pending") await giveFriend(tx, r, adv.customer.firstName, cfg, out);
      return r;
    });
    await afterGrant(out);
    if (status === "pending" && out.coupons[0])
      await messaging.email(friend.email, "referral.welcome", {
        firstName: friend.firstName || "there", advocate: adv.customer.firstName, code: out.coupons[0], reward: rewardLabel(cfg.friendReward, "friend").replace("their", "your"),
      });
    return r;
  },

  /** order.paid: attach the friend's first paid order (or expire when it doesn't reach the minimum) */
  async onOrderPaid(orderId: string) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, customerId: true, subtotal: true, discount: true, number: true } });
    if (!o?.customerId) return null;
    const r = await prisma.referral.findUnique({ where: { friendCustomerId: o.customerId } });
    if (!r || r.orderId || !["pending", "flagged"].includes(r.status)) return null;
    const cfg = await settingsService.get("referrals");
    const earlier = await prisma.order.count({ where: { customerId: o.customerId, id: { not: o.id }, paidAt: { not: null } } });
    const spend = Math.max(0, o.subtotal - o.discount);
    if (spend >= cfg.qualifyingSpend && (!cfg.requireFirstOrder || earlier === 0))
      return prisma.referral.update({ where: { id: r.id }, data: { orderId: o.id, spend } });
    if (cfg.requireFirstOrder)
      return prisma.referral.update({
        where: { id: r.id },
        data: { status: "expired", spend, note: earlier ? "Didn't qualify on the first order" : `First order ${o.number} was below ${formatNaira(cfg.qualifyingSpend)}` },
      });
    return null;
  },

  /** job: qualify referrals whose order passed the return window, reward them, expire stale ones */
  async qualifyDue(now = new Date()) {
    const cfg = await settingsService.get("referrals");
    const { windowDays } = await settingsService.get("returns");
    const delay = (cfg.qualifyDelayDays ?? windowDays) * DAY;
    const res = { qualified: 0, rewarded: 0, expired: 0 };

    const withOrder = await prisma.referral.findMany({ where: { status: { in: ["pending", "qualified"] }, orderId: { not: null } }, take: 500 });
    const orders = await prisma.order.findMany({
      where: { id: { in: withOrder.map((r) => r.orderId!) } },
      select: { id: true, status: true, subtotal: true, discount: true, amountRefunded: true, deliveredAt: true },
    });
    for (const r of withOrder) {
      const o = orders.find((x) => x.id === r.orderId);
      const net = o ? o.subtotal - o.discount - o.amountRefunded : 0;
      if (!o || ["cancelled", "refunded", "returned"].includes(o.status) || net < cfg.qualifyingSpend) {
        await prisma.referral.update({ where: { id: r.id }, data: { status: "expired", note: "The qualifying order was cancelled or refunded" } });
        res.expired++;
        continue;
      }
      if (r.status === "pending") {
        if (!o.deliveredAt || o.deliveredAt.getTime() + delay > now.getTime()) continue;
        await prisma.referral.update({ where: { id: r.id }, data: { status: "qualified", spend: net } });
        res.qualified++;
      }
      if (cfg.autoApproveWithinLimit && r.fraudScore < cfg.fraudScoreThreshold) {
        try {
          if (await reward(r.id, "system")) res.rewarded++;
        } catch (err) {
          logger.error({ err, referralId: r.id }, "referrals: reward failed");
        }
      }
    }

    const stale = await prisma.referral.updateMany({
      where: { status: "pending", orderId: null, createdAt: { lt: new Date(now.getTime() - cfg.pendingExpiryDays * DAY) } },
      data: { status: "expired", note: `No qualifying order within ${cfg.pendingExpiryDays} days` },
    });
    res.expired += stale.count;
    return res;
  },

  // ── admin /referrals ──
  async overview() {
    const [clicks, groups, friends] = await Promise.all([
      prisma.advocate.aggregate({ _sum: { clicks: true } }),
      prisma.referral.groupBy({ by: ["status", "channel"], _count: { _all: true }, _sum: { reward: true } }),
      prisma.referral.findMany({ where: { friendCustomerId: { not: null }, status: { notIn: ["rejected"] } }, select: { friendCustomerId: true } }),
    ]);
    const revenue = Number(
      (await prisma.customerStats.aggregate({ where: { customerId: { in: friends.map((f) => f.friendCustomerId!) } }, _sum: { totalSpend: true } }))._sum.totalSpend ?? 0,
    );
    const totalClicks = clicks._sum.clicks ?? 0;
    const signups = groups.reduce((n, g) => n + g._count._all, 0);
    const count = (...s: string[]) => groups.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
    const rewards = groups.filter((g) => g.status === "rewarded").reduce((n, g) => n + (g._sum.reward ?? 0), 0);
    const channels = new Map<string, number>();
    for (const g of groups) channels.set(g.channel, (channels.get(g.channel) ?? 0) + g._count._all);
    const top = await this.advocates({ page: 1, pageSize: 5, status: "all", sort: "revenue", activeOnly: true });
    return {
      kpis: {
        clicks: totalClicks,
        signups,
        conversion: totalClicks ? Math.round((signups / totalClicks) * 1000) / 10 : 0,
        qualified: count("qualified", "rewarded"),
        rewarded: count("rewarded"),
        flagged: count("flagged"),
        revenue,
        rewardsPaid: rewards,
        roi: rewards ? Math.round(((revenue - rewards) / rewards) * 100) : 0,
      },
      funnel: [
        { label: "Clicks", value: totalClicks },
        { label: "Sign-ups", value: signups },
        { label: "Qualified", value: count("qualified", "rewarded") },
        { label: "Rewarded", value: count("rewarded") },
      ],
      channels: [...channels.entries()].map(([channel, n]) => ({ channel, count: n, pct: signups ? Math.round((n / signups) * 1000) / 10 : 0 })).sort((a, b) => b.count - a.count),
      leaderboard: top.data,
    };
  },

  async list(q: ReferralListQuery) {
    const base: Prisma.ReferralWhereInput = {
      ...(q.channel ? { channel: q.channel } : {}),
      ...(q.advocateId ? { advocateId: q.advocateId } : {}),
      ...(q.q
        ? { OR: [{ friendName: { contains: q.q } }, { friendEmail: { contains: q.q } }, { advocate: { code: { contains: q.q } } }, { advocate: { customer: { email: { contains: q.q } } } }] }
        : {}),
    };
    const where = { ...base, ...(q.status !== "all" ? { status: q.status } : {}) };
    const [rows, total, groups] = await Promise.all([
      prisma.referral.findMany({ where, include: advocateInclude, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.referral.count({ where }),
      prisma.referral.groupBy({ by: ["status"], where: base, _count: { _all: true }, _sum: { reward: true, spend: true } }),
    ]);
    const orders = await prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => !!x) } }, select: { id: true, number: true } });
    const tabs: Record<string, number> = { all: 0, ...Object.fromEntries(Object.keys(REFERRAL_LABEL).map((k) => [k, 0])) };
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    return withMeta(rows.map((r) => toAdminReferral(r, orders.find((o) => o.id === r.orderId)?.number)), {
      ...pageMeta(q, total),
      tabs,
      kpis: {
        rewardsPaid: groups.find((g) => g.status === "rewarded")?._sum.reward ?? 0,
        spend: groups.reduce((n, g) => n + (g._sum.spend ?? 0), 0),
      },
    });
  },

  async get(id: string) {
    const r = await prisma.referral.findUnique({ where: { id }, include: advocateInclude });
    if (!r) throw ApiError.notFound("Referral");
    const o = r.orderId ? await prisma.order.findUnique({ where: { id: r.orderId }, select: { number: true } }) : null;
    return toAdminReferral(r, o?.number);
  },

  async approve(id: string, note: string | undefined, actor: string) {
    const before = await this.get(id);
    if (note) await prisma.referral.update({ where: { id }, data: { note } });
    await reward(id, actor, true);
    return { before, after: await this.get(id) };
  },

  async setStatus(id: string, status: "rejected" | "flagged" | "pending", note: string | undefined, actor: string) {
    const before = await this.get(id);
    if (before.status === "rewarded") throw ApiError.conflict("INVALID_STATE", "This referral has already been rewarded.");
    if (status === "flagged" && !["pending", "qualified"].includes(before.status)) throw ApiError.conflict("INVALID_STATE", `A ${before.status} referral can't be flagged.`);
    const by = status === "rejected" ? "Rejected" : status === "flagged" ? "Flagged" : "Reopened";
    await prisma.referral.update({ where: { id }, data: { status, note: [note, `${by} by ${actor}`].filter(Boolean).join(" · ") } });
    return { before, after: await this.get(id) };
  },

  async advocates(q: AdvocateListQuery) {
    const where: Prisma.AdvocateWhereInput = {
      ...(q.status !== "all" ? { status: q.status } : {}),
      ...(q.tier ? { customer: { tier: q.tier } } : {}),
      ...(q.activeOnly ? { OR: [{ clicks: { gt: 0 } }, { referrals: { some: {} } }] } : {}),
      ...(q.q ? { AND: [{ OR: [{ code: { contains: q.q } }, { customer: { email: { contains: q.q } } }, { customer: { firstName: { contains: q.q } } }, { customer: { lastName: { contains: q.q } } }] }] } : {}),
    };
    const include = { customer: { select: { id: true, firstName: true, lastName: true, email: true, tier: true } } } as const;
    if (q.sort === "recent" || q.sort === "clicks") {
      const [rows, total] = await Promise.all([
        prisma.advocate.findMany({ where, include, orderBy: q.sort === "recent" ? { createdAt: "desc" } : { clicks: "desc" }, ...paging(q) }),
        prisma.advocate.count({ where }),
      ]);
      const s = await advocateStats(rows.map((a) => a.id));
      return withMeta(rows.map((a) => toAdvocate(a, s.get(a.id))), pageMeta(q, total));
    }
    // revenue / qualified: computed figures → sort in memory (advocates with activity only, by default)
    const rows = await prisma.advocate.findMany({ where, include, take: 5000 });
    const s = await advocateStats(rows.map((a) => a.id));
    const all = rows.map((a) => toAdvocate(a, s.get(a.id)))
      .sort((a, b) => (q.sort === "qualified" ? b.qualified - a.qualified : b.revenueDrivenMinor - a.revenueDrivenMinor) || b.clicks - a.clicks);
    const { skip, take } = paging(q);
    return withMeta(all.slice(skip, skip + take), pageMeta(q, all.length));
  },

  async setAdvocateStatus(id: string, status: "active" | "paused" | "banned") {
    const a = await prisma.advocate.findUnique({ where: { id } });
    if (!a) throw ApiError.notFound("Advocate");
    const after = await prisma.advocate.update({ where: { id }, data: { status } });
    return { before: { id, status: a.status, code: a.code }, after: { id, status: after.status, code: after.code } };
  },

  config: () => settingsService.get("referrals"),
  updateConfig: (b: ConfigBody, by: string) => settingsService.update("referrals", b, by),
};

export const qualifyReferralsJob = defineJob("referrals.qualify", async () => {
  const r = await referralsService.qualifyDue();
  if (r.qualified || r.rewarded || r.expired) logger.info(r, "referrals: qualify run");
});
