/**
 * Announcement bar (asl-admin /announcement): site_top + checkout_top on the storefront, admin_top in the admin app.
 * Higher priority is shown first; audience is resolved from the caller's account + Club tier.
 */
import type { Announcement, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import {
  announcementAudiences, checkTemplate, ctr, deviceWhere, effectiveStatus, liveNow, render, resolveViewer, statusTabs, templateVars,
  type TemplateVars,
} from "../impressions/placements";
import { ANN_PLACEMENTS, type AnnouncementBody, type AnnouncementListQuery, type AnnouncementPatch, type StoreAnnouncementsQuery } from "./announcements.schemas";

const toAdmin = (a: Announcement) => ({
  id: a.id, title: a.title, message: a.message, emoji: a.emoji, ctaLabel: a.ctaLabel, ctaHref: a.ctaHref, style: a.style, bg: a.bg, fg: a.fg,
  placement: a.placement, audience: a.audience, device: a.device, dismissible: a.dismissible, priority: a.priority, status: a.status,
  startsAt: a.startsAt, endsAt: a.endsAt, impressions: a.impressions, clicks: a.clicks, dismisses: a.dismisses, ctr: ctr(a.impressions, a.clicks),
  createdAt: a.createdAt, updatedAt: a.updatedAt,
});

const toStore = (a: Announcement, vars: TemplateVars) => ({
  id: a.id, placement: a.placement, audience: a.audience, device: a.device, priority: a.priority,
  message: render(a.message, vars), emoji: a.emoji, ctaLabel: render(a.ctaLabel, vars), ctaHref: a.ctaHref,
  style: a.style, bg: a.bg, fg: a.fg, dismissible: a.dismissible, endsAt: a.endsAt,
});

const ORDER: Prisma.AnnouncementOrderByWithRelationInput[] = [{ priority: "desc" }, { updatedAt: "desc" }, { id: "asc" }];

async function find(id: string) {
  const a = await prisma.announcement.findUnique({ where: { id } });
  if (!a) throw ApiError.notFound("Announcement");
  return a;
}

export const announcementsService = {
  /** every qualifying bar, highest priority first (the web shows the first one not dismissed) */
  async storeList(q: StoreAnnouncementsQuery, customerId?: string) {
    const [viewer, vars] = await Promise.all([resolveViewer(customerId), templateVars()]);
    const rows = await prisma.announcement.findMany({
      where: {
        ...liveNow(), ...deviceWhere(q.device), audience: { in: announcementAudiences(viewer) },
        placement: q.placement ?? { in: ["site_top", "checkout_top"] },
      },
      orderBy: ORDER,
    });
    return rows.map((a) => toStore(a, vars));
  },

  /** admin_top notices for the admin app's own bar */
  async adminBar() {
    const vars = await templateVars();
    const rows = await prisma.announcement.findMany({ where: { ...liveNow(), placement: "admin_top" }, orderBy: ORDER });
    return rows.map((a) => toStore(a, vars));
  },

  async list(q: AnnouncementListQuery) {
    const scoped: Prisma.AnnouncementWhereInput = {
      ...(q.placement ? { placement: q.placement } : {}),
      ...(q.audience ? { audience: q.audience } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { message: { contains: q.q } }] } : {}),
    };
    const where: Prisma.AnnouncementWhereInput = { ...scoped, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, groups, sums, byPlacement, current] = await Promise.all([
      prisma.announcement.findMany({ where, orderBy: ORDER, ...paging(q) }),
      prisma.announcement.count({ where }),
      prisma.announcement.groupBy({ by: ["status"], where: scoped, _count: { _all: true } }),
      prisma.announcement.aggregate({ where: scoped, _sum: { impressions: true, clicks: true, dismisses: true } }),
      prisma.announcement.groupBy({ by: ["placement", "status"], _count: { _all: true } }),
      // what everyone currently sees on this placement (top live item for the broadest audience)
      prisma.announcement.findFirst({ where: { ...liveNow(), placement: q.placement ?? "site_top" }, orderBy: ORDER }),
    ]);
    const tabs = statusTabs(groups);
    const impressions = sums._sum.impressions ?? 0;
    const clicks = sums._sum.clicks ?? 0;
    const dismisses = sums._sum.dismisses ?? 0;
    const placements = ANN_PLACEMENTS.map((p) => {
      const g = byPlacement.filter((x) => x.placement === p);
      return { placement: p, total: g.reduce((s, x) => s + x._count._all, 0), live: g.find((x) => x.status === "live")?._count._all ?? 0 };
    });
    return withMeta(rows.map(toAdmin), {
      ...pageMeta(q, total), tabs, placements, showingNow: current?.id ?? null,
      kpis: { live: tabs.live, scheduled: tabs.scheduled, impressions, clicks, dismisses, ctr: ctr(impressions, clicks), dismissRate: ctr(impressions, dismisses) },
    });
  },

  async get(id: string) {
    return toAdmin(await find(id));
  },

  async create(b: AnnouncementBody) {
    checkTemplate(b.message, b.ctaLabel);
    const row = await prisma.announcement.create({ data: { ...b, status: effectiveStatus(b.status, b.startsAt, b.endsAt) } });
    return toAdmin(row);
  },

  async update(id: string, patch: AnnouncementPatch) {
    const cur = await find(id);
    checkTemplate(patch.message, patch.ctaLabel);
    const startsAt = patch.startsAt === undefined ? cur.startsAt : patch.startsAt;
    const endsAt = patch.endsAt === undefined ? cur.endsAt : patch.endsAt;
    const row = await prisma.announcement.update({ where: { id }, data: { ...patch, status: effectiveStatus(patch.status ?? cur.status, startsAt, endsAt) } });
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  async setStatus(id: string, status: Announcement["status"]) {
    const cur = await find(id);
    const row = await prisma.announcement.update({ where: { id }, data: { status: effectiveStatus(status, cur.startsAt, cur.endsAt) } });
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  async duplicate(id: string) {
    const s = await find(id);
    const copy = await prisma.announcement.create({
      data: {
        title: `${s.title} (copy)`, message: s.message, emoji: s.emoji, ctaLabel: s.ctaLabel, ctaHref: s.ctaHref, style: s.style, bg: s.bg, fg: s.fg,
        placement: s.placement, audience: s.audience, device: s.device, dismissible: s.dismissible, priority: s.priority, status: "paused",
        startsAt: s.startsAt, endsAt: s.endsAt,
      },
    });
    return toAdmin(copy);
  },

  async remove(id: string) {
    const a = await find(id);
    await prisma.announcement.delete({ where: { id } });
    return toAdmin(a);
  },
};
