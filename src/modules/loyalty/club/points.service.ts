/**
 * Points engine (ASL Club). Every change is a PointsEntry row; earning rows are "lots" that carry
 * `remaining` + `expiresAt`, and every spend / clawback / expiry consumes lots oldest-expiry first (FIFO).
 *
 * Invariant: available balance = Σ remaining of unexpired lots. All mutations run inside a transaction
 * that first locks the customer row, so two redemptions can't spend the same points.
 *
 * Ledger (points are a liability, 2300, valued at `club.pointValueKobo`):
 *   points given (orders, bonuses, admin +, refunds of redemptions)  Dr 5300 marketing & rewards / Cr 2300
 *   points taken back (refund clawback, expiry, admin −)             Dr 2300 / Cr 5300
 *   redemptions (see club.service redeem)                            Dr 2300 / Cr 2000 wallet (credit) or 5300 (others)
 * One journal per PointsEntry (reference PTS-<id>, source "adjustment"), posted after commit with postOnce.
 */
import type { PointsEntry } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { logger } from "@/core/utils/logger";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";

export const POINTS_ACC = { liability: "2300", rewards: "5300", wallets: "2000" } as const;

/** refType values (what kind of movement an entry is) */
export type PointsKind =
  | "order" | "order_reversal" | "redemption" | "redemption_refund" | "adjustment"
  | "expiry" | "signup" | "review" | "birthday" | "referral";

const unexpired = (now = new Date()) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });

export async function lockCustomer(tx: Tx, customerId: string) {
  await tx.$queryRaw`SELECT id FROM \`Customer\` WHERE id = ${customerId} FOR UPDATE`;
}

/** points the customer can spend right now */
export async function available(db: Tx | typeof prisma, customerId: string) {
  const r = await db.pointsEntry.aggregate({ where: { customerId, remaining: { gt: 0 }, ...unexpired() }, _sum: { remaining: true } });
  return r._sum.remaining ?? 0;
}

/** balances for many customers at once (admin customer lists) */
export async function availableMany(customerIds: string[]) {
  if (!customerIds.length) return new Map<string, number>();
  const rows = await prisma.pointsEntry.groupBy({
    by: ["customerId"],
    where: { customerId: { in: customerIds }, remaining: { gt: 0 }, ...unexpired() },
    _sum: { remaining: true },
  });
  return new Map(rows.map((r) => [r.customerId, r._sum.remaining ?? 0]));
}

async function expiryDate() {
  const { expiryMonths } = await settingsService.get("club");
  if (!expiryMonths) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + expiryMonths);
  return d;
}

type Movement = { kind: PointsKind; reason: string; refId?: string | null; actor?: string | null };

/** add points as a new lot (caller holds the customer lock) */
async function credit(tx: Tx, customerId: string, points: number, m: Movement) {
  if (points <= 0) return null;
  return tx.pointsEntry.create({
    data: { customerId, delta: points, remaining: points, expiresAt: await expiryDate(), reason: m.reason, refType: m.kind, refId: m.refId ?? null, actor: m.actor ?? null },
  });
}

/** consume `points` FIFO from unexpired lots (caller holds the lock). Throws when the balance is short. */
async function consume(tx: Tx, customerId: string, points: number) {
  const lots = await tx.pointsEntry.findMany({
    where: { customerId, remaining: { gt: 0 }, ...unexpired() },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
  });
  const have = lots.reduce((n, l) => n + l.remaining, 0);
  if (have < points) throw ApiError.badRequest("INSUFFICIENT_POINTS", `You have ${have.toLocaleString("en-NG")} points.`, { points: have, needed: points });
  let left = points;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining);
    await tx.pointsEntry.update({ where: { id: l.id }, data: { remaining: l.remaining - take } });
    left -= take;
  }
}

/** take points away (FIFO). `cap`: take at most what's available instead of failing. */
async function debit(tx: Tx, customerId: string, points: number, m: Movement, opts: { cap?: boolean } = {}) {
  let take = points;
  if (opts.cap) take = Math.min(points, await available(tx, customerId));
  if (take <= 0) return null;
  await consume(tx, customerId, take);
  return tx.pointsEntry.create({
    data: { customerId, delta: -take, remaining: 0, reason: m.reason, refType: m.kind, refId: m.refId ?? null, actor: m.actor ?? null },
  });
}

/** liability journal for plain points movements (redemptions are journaled by the redeem flow) */
async function journal(entries: (PointsEntry | null | undefined)[]) {
  const { pointValueKobo } = await settingsService.get("club");
  if (!pointValueKobo) return;
  for (const e of entries) {
    if (!e || e.delta === 0 || e.refType === "redemption") continue;
    const amount = Math.abs(e.delta) * pointValueKobo;
    const given = e.delta > 0;
    try {
      await ledgerService.postOnce("adjustment", `PTS-${e.id}`, {
        date: e.createdAt,
        description: `Loyalty points ${given ? "issued" : "released"} · ${e.reason}`.slice(0, 190),
        createdBy: SYSTEM_USER,
        lines: given
          ? [{ accountCode: POINTS_ACC.rewards, debit: amount, credit: 0, memo: `${e.delta} pts` }, { accountCode: POINTS_ACC.liability, debit: 0, credit: amount, memo: "Points liability" }]
          : [{ accountCode: POINTS_ACC.liability, debit: amount, credit: 0, memo: `${e.delta} pts` }, { accountCode: POINTS_ACC.rewards, debit: 0, credit: amount, memo: "Points released" }],
      });
    } catch (err) {
      logger.error({ err, entry: e.id }, "ledger: points journal failed");
    }
  }
}

/** expire lots past their date: one negative entry per lot, remaining → 0 */
async function expireDue(now = new Date()) {
  const due = await prisma.pointsEntry.findMany({
    where: { remaining: { gt: 0 }, expiresAt: { lte: now } },
    select: { customerId: true },
    distinct: ["customerId"],
    take: 1000,
  });
  let expired = 0;
  for (const { customerId } of due) {
    const created = await prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      const lots = await tx.pointsEntry.findMany({ where: { customerId, remaining: { gt: 0 }, expiresAt: { lte: now } } });
      const out: PointsEntry[] = [];
      for (const l of lots) {
        await tx.pointsEntry.update({ where: { id: l.id }, data: { remaining: 0 } });
        out.push(
          await tx.pointsEntry.create({
            data: { customerId, delta: -l.remaining, remaining: 0, reason: "Points expired", refType: "expiry", refId: l.id },
          }),
        );
        expired += l.remaining;
      }
      return out;
    });
    await journal(created);
  }
  return { customers: due.length, points: expired };
}

export const pointsService = {
  lockCustomer,
  available,
  availableMany,
  credit,
  debit,
  consume,
  journal,
  expireDue,

  /** one-off movement in its own transaction (bonuses, admin adjustments) */
  async apply(customerId: string, delta: number, m: Movement, opts: { once?: boolean } = {}) {
    const entry = await prisma.$transaction(async (tx) => {
      await lockCustomer(tx, customerId);
      if (opts.once && m.refId) {
        const exists = await tx.pointsEntry.findFirst({ where: { customerId, refType: m.kind, refId: m.refId }, select: { id: true } });
        if (exists) return null;
      }
      return delta >= 0 ? credit(tx, customerId, delta, m) : debit(tx, customerId, -delta, m);
    });
    await journal([entry]);
    return entry;
  },
};
