/**
 * Provider settlements to the business bank account (asl-admin /payouts).
 * `sync()` builds one payout per provider and capture day from succeeded gateway payments
 * once they are older than `finance.payoutDelayDays`; marking a payout paid posts Dr bank / Cr clearing.
 */
import crypto from "node:crypto";
import type { PayoutStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { toCsv } from "@/core/utils/csv";
import { logger } from "@/core/utils/logger";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { env } from "@/config/env";
import { paymentProvider } from "@/providers/payment/payment";
import { PAYOUT_STATUS_LABEL, providerLabel, toPayout } from "./payouts.mapper";
import type { PayoutBody, PayoutListQuery, PayoutPatch } from "./payouts.schemas";

const DAY = 86_400_000;
const STATUSES: PayoutStatus[] = ["scheduled", "in_transit", "paid", "failed", "on_hold"];
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const count = { _count: { select: { lines: true } } } as const;

function where(q: Omit<PayoutListQuery, "page" | "pageSize" | "sort">): Prisma.PayoutWhereInput {
  return {
    ...(q.status ? { status: q.status } : {}),
    ...(q.provider ? { provider: q.provider } : {}),
    ...(q.from || q.to ? { scheduledAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    ...(q.q ? { OR: [{ number: { contains: q.q } }, { reference: { contains: q.q } }, { notes: { contains: q.q } }, { lines: { some: { OR: [{ paymentRef: { contains: q.q } }, { orderNumber: { contains: q.q } }] } } }] } : {}),
  };
}

async function find(id: string) {
  const p = await prisma.payout.findFirst({ where: id.startsWith("PO-") ? { number: id } : { id }, include: { lines: { orderBy: { capturedAt: "asc" } } } });
  if (!p) throw ApiError.notFound("Payout");
  return p;
}

function must(p: { status: PayoutStatus }, allowed: PayoutStatus[], what: string) {
  if (!allowed.includes(p.status))
    throw ApiError.conflict("INVALID_STATE", `Only ${allowed.map((s) => PAYOUT_STATUS_LABEL[s].toLowerCase()).join(" or ")} payouts can be ${what}.`);
}

async function bankDefaults() {
  const f = await settingsService.get("finance");
  return { bankName: f.payoutBankName, bankAccountMasked: f.payoutAccountMasked, bankAccountName: f.payoutAccountName, delayDays: f.payoutDelayDays };
}

export const payoutsService = {
  async list(q: PayoutListQuery) {
    const w = where(q);
    const { status: _s, ...rest } = q;
    const now = new Date();
    const [rows, total, byStatus, next, paid30, pending] = await Promise.all([
      prisma.payout.findMany({ where: w, ...paging(q), orderBy: [{ scheduledAt: "desc" }, { createdAt: "desc" }], include: count }),
      prisma.payout.count({ where: w }),
      prisma.payout.groupBy({ by: ["status"], where: where(rest), _count: { _all: true } }),
      prisma.payout.findFirst({ where: { status: { in: ["scheduled", "in_transit"] } }, orderBy: { scheduledAt: "asc" } }),
      prisma.payout.aggregate({ where: { status: "paid", paidAt: { gte: new Date(now.getTime() - 30 * DAY) } }, _sum: { net: true }, _count: { _all: true } }),
      prisma.payout.aggregate({ where: { status: { in: ["scheduled", "in_transit", "on_hold"] } }, _sum: { net: true }, _count: { _all: true } }),
    ]);
    const tabs = Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((b) => b.status === s)?._count._all ?? 0]));
    return withMeta(rows.map(toPayout), {
      ...pageMeta(q, total),
      tabs: { all: Object.values(tabs).reduce((n, c) => n + c, 0), ...tabs },
      kpis: {
        nextPayout: next ? { id: next.id, number: next.number, net: next.net, scheduledAt: next.scheduledAt, provider: providerLabel(next.provider) } : null,
        paidLast30d: paid30._sum.net ?? 0,
        paidLast30dCount: paid30._count._all,
        pending: pending._sum.net ?? 0,
        pendingCount: pending._count._all,
      },
    });
  },

  async get(id: string) {
    return toPayout(await find(id));
  },

  async create(b: PayoutBody) {
    const bank = await bankDefaults();
    const net = b.gross - b.fees - b.refunds + b.adjustments;
    const p = await prisma.$transaction(async (tx) => {
      const number = formatters.payout(await nextSequence(tx, "payout", 20482));
      return tx.payout.create({
        data: {
          number, provider: b.provider, reference: b.reference ?? `MAN-${crypto.randomBytes(4).toString("hex").toUpperCase()}`, status: b.status,
          gross: b.gross, fees: b.fees, refunds: b.refunds, adjustments: b.adjustments, net, scheduledAt: b.scheduledAt, notes: b.notes ?? null,
          bankName: b.bankName ?? bank.bankName, bankAccountMasked: b.bankAccountMasked ?? bank.bankAccountMasked, bankAccountName: b.bankAccountName ?? bank.bankAccountName,
        },
        include: { lines: true },
      });
    });
    return toPayout(p);
  },

  async update(id: string, b: PayoutPatch) {
    const p = await find(id);
    if (b.scheduledAt) must(p, ["scheduled", "on_hold", "failed"], "rescheduled");
    const u = await prisma.payout.update({
      where: { id: p.id },
      data: { ...(b.notes !== undefined ? { notes: b.notes } : {}), ...(b.scheduledAt ? { scheduledAt: b.scheduledAt } : {}) },
      include: { lines: true },
    });
    return { before: toPayout(p), after: toPayout(u) };
  },

  async markPaid(id: string) {
    const p = await find(id);
    must(p, ["scheduled", "in_transit"], "marked paid");
    // conditional update: a double click can't pay (and journal) twice
    const r = await prisma.payout.updateMany({ where: { id: p.id, status: p.status }, data: { status: "paid", paidAt: new Date(), failureReason: null } });
    if (!r.count) throw ApiError.conflict("INVALID_STATE", "This payout changed meanwhile. Reload and try again.");
    events.emit("payout.paid", { payoutId: p.id });
    return this.get(p.id);
  },

  async markFailed(id: string, reason: string) {
    const p = await find(id);
    must(p, ["scheduled", "in_transit"], "marked failed");
    await prisma.payout.update({ where: { id: p.id }, data: { status: "failed", failureReason: reason } });
    return this.get(p.id);
  },

  async retry(id: string) {
    const p = await find(id);
    must(p, ["failed"], "retried");
    await prisma.payout.update({ where: { id: p.id }, data: { status: "scheduled", failureReason: null, scheduledAt: new Date() } });
    return this.get(p.id);
  },

  async hold(id: string, note: string) {
    const p = await find(id);
    must(p, ["scheduled", "in_transit"], "put on hold");
    await prisma.payout.update({ where: { id: p.id }, data: { status: "on_hold", notes: note } });
    return this.get(p.id);
  },

  async release(id: string) {
    const p = await find(id);
    must(p, ["on_hold"], "released");
    await prisma.payout.update({ where: { id: p.id }, data: { status: "scheduled" } });
    return this.get(p.id);
  },

  /** deleting a synced payout frees its payments for the next sync */
  async remove(id: string) {
    const p = await find(id);
    must(p, ["scheduled", "failed"], "deleted");
    await prisma.payout.delete({ where: { id: p.id } });
    return { deleted: true, number: p.number };
  },

  async exportCsv(q: Omit<PayoutListQuery, "page" | "pageSize">) {
    const rows = await prisma.payout.findMany({ where: where(q), orderBy: { scheduledAt: "desc" }, take: 50_000, include: count });
    const n = (k: number) => k / 100;
    return toCsv(
      rows.map((p) => {
        const r = toPayout(p);
        return { ...r, gross: n(p.gross), fees: n(p.fees), refunds: n(p.refunds), adjustments: n(p.adjustments), net: n(p.net) };
      }),
      ["number", "providerLabel", "reference", "statusLabel", "gross", "fees", "refunds", "adjustments", "net", "bankName", "bankAccountMasked", "scheduledAt", "paidAt", "txnCount", "failureReason", "notes"],
      ["Payout", "Provider", "Reference", "Status", "Gross (NGN)", "Fees (NGN)", "Refunds (NGN)", "Adjustments (NGN)", "Net (NGN)", "Bank", "Account", "Scheduled", "Paid", "Transactions", "Failure reason", "Notes"],
    );
  },

  /**
   * Build settlements from captured gateway payments: one payout per provider + capture day (UTC),
   * for days at least `payoutDelayDays` old, skipping payments already in a payout.
   */
  async sync(now = new Date()) {
    const bank = await bankDefaults();
    // capture day D settles on D + delay → include days strictly before today − delay + 1
    const cutoff = new Date(startOfUtcDay(now).getTime() + (1 - bank.delayDays) * DAY);
    const created = await prisma.$transaction(
      async (tx) => {
        // serialise concurrent syncs (job + button) on one counter row
        await nextSequence(tx, "lock:payouts.sync", 0);
        const pays = await tx.payment.findMany({
          where: { provider: { not: "manual" }, status: { in: ["succeeded", "partially_refunded", "refunded"] }, paidAt: { not: null, lt: cutoff } },
          // refunds the provider returns out of the settlement (failed ones and ones moved to the wallet never left it)
          include: { refunds: { where: { status: { in: ["pending", "processed"] } } }, order: { select: { number: true } } },
          orderBy: { paidAt: "asc" },
          take: 20_000,
        });
        if (!pays.length) return [];
        const taken = new Set(
          (await tx.payoutLine.findMany({ where: { paymentRef: { in: pays.map((p) => p.reference) } }, select: { paymentRef: true } })).map((l) => l.paymentRef),
        );
        const groups = new Map<string, typeof pays>();
        for (const p of pays) {
          if (taken.has(p.reference)) continue;
          const key = `${p.provider}|${startOfUtcDay(p.paidAt!).toISOString()}`;
          groups.set(key, [...(groups.get(key) ?? []), p]);
        }
        const out: string[] = [];
        for (const [key, list] of groups) {
          const [provider, dayIso] = key.split("|");
          const day = new Date(dayIso);
          const gross = list.reduce((n, p) => n + p.amount, 0);
          const fees = list.reduce((n, p) => n + p.fee, 0);
          const refunds = list.reduce((n, p) => n + p.refunds.reduce((m, r) => m + r.amount, 0), 0);
          const number = formatters.payout(await nextSequence(tx, "payout", 20482));
          const scheduledAt = new Date(Math.max(day.getTime() + bank.delayDays * DAY, startOfUtcDay(now).getTime()));
          const p = await tx.payout.create({
            data: {
              number, provider, reference: `STL-${provider.slice(0, 3).toUpperCase()}-${ymd(day)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
              status: "scheduled", gross, fees, refunds, adjustments: 0, net: gross - fees - refunds, scheduledAt,
              bankName: bank.bankName, bankAccountMasked: bank.bankAccountMasked, bankAccountName: bank.bankAccountName,
              notes: `Settlement for payments captured ${dayIso.slice(0, 10)}`,
              lines: {
                create: list.map((x) => ({ paymentRef: x.reference, orderNumber: x.order?.number ?? null, gross: x.amount, fee: x.fee, net: x.amount - x.fee, capturedAt: x.paidAt! })),
              },
            },
          });
          out.push(p.id);
        }
        return out;
      },
      { timeout: 60_000 },
    );
    if (created.length) logger.info({ count: created.length }, "payouts synced");
    for (const payoutId of created) events.emit("payout.pending", { payoutId });
    const rows = await prisma.payout.findMany({ where: { id: { in: created } }, include: count, orderBy: { scheduledAt: "asc" } });
    return { created: rows.length, payouts: rows.map(toPayout) };
  },

  /** admin → payouts / settings: the live gateway + the checkout methods (PaymentMethodSetting) */
  async providers() {
    const methods = await prisma.paymentMethodSetting.findMany({ orderBy: { position: "asc" } });
    const gw = paymentProvider;
    const GATEWAYS = ["paystack", "flutterwave", "stripe"];
    // card methods run through the live gateway (the mock stands in for Paystack); wallet / bank transfer / COD are ours
    const connected = (id: string) => !GATEWAYS.includes(id) || id === gw.name || (gw.name === "mock" && id === "paystack");
    return {
      active: {
        name: gw.name,
        label: providerLabel(gw.name),
        testMode: gw.testMode,
        publicKey: gw.publicKey ?? null,
        webhookUrl: `${env.APP_URL}/api/v1/webhooks/payments/${gw.name}`,
        asyncRefunds: gw.name !== "mock",
        asyncTransfers: gw.name !== "mock",
      },
      methods: methods.map((m) => ({
        id: m.id, label: m.label, provider: m.provider, providerLabel: providerLabel(m.provider), enabled: m.enabled, testMode: m.testMode,
        fee: m.feeLabel, position: m.position, gateway: GATEWAYS.includes(m.id), connected: connected(m.id),
        // shown as test mode when the setting says so or the gateway runs on test keys
        testModeEffective: GATEWAYS.includes(m.id) && connected(m.id) ? m.testMode || gw.testMode : m.testMode,
      })),
    };
  },
};

/** daily: build settlements (schedules.ts) */
export const payoutsSyncJob = defineJob("payouts.sync", async () => {
  await payoutsService.sync();
});
