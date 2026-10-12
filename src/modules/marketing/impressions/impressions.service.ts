/**
 * Storefront merchandising counters + the schedule job shared by banners, announcements and slots.
 *
 * Counters: one batch request → events grouped per (kind, id, event) → one `increment` UPDATE per group,
 * all in one transaction. Simple and exact; no Redis buffer yet (the plan's "Redis counters flushed every
 * minute" is only worth it at much higher traffic — the endpoint contract stays the same if it's added).
 */
import { prisma } from "@/core/db/prisma";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import type { ImpressionEvent } from "./impressions.schemas";

/** counter column per kind + event (slots have no dismiss counter) */
const COLUMN = {
  banner: { impression: "impressions", click: "clicks", dismiss: "dismissals" },
  announcement: { impression: "impressions", click: "clicks", dismiss: "dismisses" },
  slot: { impression: "impressions", click: "clicks", dismiss: null },
} as const;

export const impressionsService = {
  async record(events: ImpressionEvent[]) {
    const groups = new Map<string, { kind: ImpressionEvent["kind"]; id: string; column: string; n: number }>();
    for (const e of events) {
      const column = COLUMN[e.kind][e.event];
      if (!column) continue;
      const key = `${e.kind}:${e.id}:${column}`;
      const g = groups.get(key);
      if (g) g.n++;
      else groups.set(key, { kind: e.kind, id: e.id, column, n: 1 });
    }
    // updateMany: unknown / deleted ids are simply ignored (no 404 for a stale page)
    const ops = [...groups.values()].map((g) => {
      const data = { [g.column]: { increment: g.n } };
      if (g.kind === "banner") return prisma.banner.updateMany({ where: { id: g.id }, data });
      if (g.kind === "announcement") return prisma.announcement.updateMany({ where: { id: g.id }, data });
      return prisma.slot.updateMany({ where: { id: g.id }, data });
    });
    const results = ops.length ? await prisma.$transaction(ops) : [];
    const recorded = [...groups.values()].reduce((s, g, i) => s + (results[i]?.count ? g.n : 0), 0);
    return { received: events.length, recorded };
  },

  /** scheduled → live at startsAt; live / scheduled → expired at endsAt (banners, announcements, slots) */
  async runSchedule(now = new Date()) {
    const goLive = { status: "scheduled" as const, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] };
    const expire = { status: { in: ["live" as const, "scheduled" as const] }, endsAt: { lte: now } };
    const [bl, al, sl, be, ae, se] = await prisma.$transaction([
      prisma.banner.updateMany({ where: goLive, data: { status: "live" } }),
      prisma.announcement.updateMany({ where: goLive, data: { status: "live" } }),
      prisma.slot.updateMany({ where: goLive, data: { status: "live" } }),
      prisma.banner.updateMany({ where: expire, data: { status: "expired" } }),
      prisma.announcement.updateMany({ where: expire, data: { status: "expired" } }),
      prisma.slot.updateMany({ where: expire, data: { status: "expired" } }),
    ]);
    const r = {
      live: { banners: bl.count, announcements: al.count, slots: sl.count },
      expired: { banners: be.count, announcements: ae.count, slots: se.count },
    };
    if (bl.count + al.count + sl.count + be.count + ae.count + se.count) logger.info(r, "merch.schedule");
    return r;
  },
};

export const merchScheduleJob = defineJob("merch.schedule", async () => void (await impressionsService.runSchedule()));
