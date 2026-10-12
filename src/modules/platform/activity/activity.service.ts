/**
 * Admin activity feed (/activity live feed + dashboard ticker). Rows are written by the
 * listeners in activity.listeners.ts from domain events; each type is visible only to staff
 * holding the matching view permission.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { pageMeta, paging } from "@/core/http/pagination";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { realtime } from "@/core/realtime/realtime";
import type { Permission } from "@/core/auth/permissions";
import type { ActivityFilters } from "./activity.schemas";

/** type key → permission needed to see it (null = every admin) */
export const ACTIVITY_TYPES = {
  "order.placed": "orders.view",
  "order.paid": "orders.view",
  "order.shipped": "orders.view",
  "order.cancelled": "orders.view",
  "order.refunded": "orders.view",
  "return.requested": "orders.view",
  "concierge.requested": "concierge.view",
  "concierge.quoted": "concierge.view",
  "concierge.approved": "concierge.view",
  "catalog.updated": "catalog.view",
  "review.submitted": "catalog.view",
  "stock.low": "catalog.view",
  "coupon.minted": "marketing.manage",
  "customer.tier_upgraded": "customers.view",
  "customer.vip": "customers.view",
  "payout.pending": "finance.view",
  "payout.paid": "finance.view",
  "ticket.created": "support.tickets",
  system: null,
} as const satisfies Record<string, Permission | null>;
export type ActivityType = keyof typeof ACTIVITY_TYPES;

export const ACTIVITY_RETENTION_DAYS = 90;

export type ActivityInput = { type: ActivityType; title: string; meta?: string | null; amount?: number | null; link?: string | null };

function visibleTypes(perms: Set<Permission>): string[] {
  return (Object.entries(ACTIVITY_TYPES) as [ActivityType, Permission | null][]).filter(([, p]) => !p || perms.has(p)).map(([t]) => t);
}

/** `order.placed,concierge.*` → the matching known type keys */
function requestedTypes(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const keys = Object.keys(ACTIVITY_TYPES);
  const out = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.endsWith(".*") || part.endsWith(".")) {
      const prefix = part.replace(/\*$/, "");
      keys.filter((k) => k.startsWith(prefix)).forEach((k) => out.add(k));
    } else if (keys.includes(part)) out.add(part);
    else keys.filter((k) => k.startsWith(`${part}.`)).forEach((k) => out.add(k)); // "order" → order.*
  }
  return [...out];
}

const toRow = (e: { id: string; type: string; title: string; meta: string | null; amount: number | null; link: string | null; createdAt: Date }) => ({
  id: e.id,
  type: e.type,
  title: e.title,
  meta: e.meta ?? undefined,
  amount: e.amount ?? undefined,
  link: e.link ?? undefined,
  at: e.createdAt.getTime(),
  createdAt: e.createdAt,
});

async function record(e: ActivityInput, opts: { dedupeHours?: number } = {}) {
  if (opts.dedupeHours && e.link) {
    const recent = await prisma.activityEntry.findFirst({
      where: { type: e.type, link: e.link, createdAt: { gte: new Date(Date.now() - opts.dedupeHours * 3_600_000) } },
      select: { id: true },
    });
    if (recent) return null;
  }
  const row = await prisma.activityEntry.create({
    data: { type: e.type, title: e.title.slice(0, 190), meta: e.meta?.slice(0, 190) ?? null, amount: e.amount ?? null, link: e.link ?? null },
  });
  // live feed: only sockets holding the type's view permission (they joined admin:activity:<perm>)
  const perm: Permission | null = ACTIVITY_TYPES[e.type];
  realtime.emit(perm ? `admin:activity:${perm}` : "admin:activity", "activity.new", toRow(row));
  return row;
}

async function list(q: ActivityFilters, perms: Set<Permission>) {
  const visible = visibleTypes(perms);
  const wanted = requestedTypes(q.type);
  const types = wanted ? visible.filter((t) => wanted.includes(t)) : visible;
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = q.from;
  if (q.since) createdAt.gt = q.since;
  if (q.to) createdAt.lte = q.to;
  const where: Prisma.ActivityEntryWhereInput = {
    type: { in: types },
    ...(Object.keys(createdAt).length ? { createdAt } : {}),
    ...(q.q ? { OR: [{ title: { contains: q.q } }, { meta: { contains: q.q } }] } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    prisma.activityEntry.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...paging(q) }),
    prisma.activityEntry.count({ where }),
    prisma.activityEntry.groupBy({ by: ["type"], where: { ...where, type: { in: visible } }, _count: { _all: true } }),
  ]);
  return {
    items: rows.map(toRow),
    meta: {
      ...pageMeta(q, total),
      types: visible,
      tabs: Object.fromEntries(counts.map((c) => [c.type, c._count._all])),
    },
  };
}

/** retention: keep ACTIVITY_RETENTION_DAYS of history */
async function prune(now = new Date(), days = ACTIVITY_RETENTION_DAYS) {
  const r = await prisma.activityEntry.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - days * 86_400_000) } } });
  if (r.count) logger.info({ removed: r.count }, "activity pruned");
  return r.count;
}

export const activityPruneJob = defineJob("activity.prune", async () => {
  await prune();
});

export const activityService = { record, list, prune, visibleTypes };
