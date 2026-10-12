/**
 * Thin promotional strips (asl-admin /banners): top bar, checkout, cart nudge, category / product ribbons,
 * concierge strip. Priority 1 is shown first within a placement.
 */
import type { Banner, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import {
  checkTemplate, ctr, deviceWhere, effectiveStatus, liveNow, moved, placementAudiences, render, reordered, resolveViewer, statusTabs,
  templateVars, type TemplateVars,
} from "../impressions/placements";
import { BANNER_PLACEMENTS, type BannerBody, type BannerListQuery, type BannerPatch, type StoreBannersQuery } from "./banners.schemas";

const toAdmin = (b: Banner) => ({
  id: b.id, name: b.name, placement: b.placement, priority: b.priority, status: b.status, device: b.device, audience: b.audience,
  message: b.message, cta: b.cta, linkTo: b.linkTo, bg: b.bg, fg: b.fg, accent: b.accent, style: b.style, icon: b.icon,
  dismissible: b.dismissible, startsAt: b.startsAt, endsAt: b.endsAt, notes: b.notes,
  impressions: b.impressions, clicks: b.clicks, dismissals: b.dismissals, ctr: ctr(b.impressions, b.clicks),
  createdAt: b.createdAt, updatedAt: b.updatedAt,
});

/** what the storefront renders (template variables filled) */
const toStore = (b: Banner, vars: TemplateVars) => ({
  id: b.id, placement: b.placement, priority: b.priority, device: b.device, audience: b.audience,
  message: render(b.message, vars), cta: render(b.cta, vars), linkTo: b.linkTo,
  bg: b.bg, fg: b.fg, accent: b.accent, style: b.style, icon: b.icon, dismissible: b.dismissible, endsAt: b.endsAt,
});

const ORDER: Prisma.BannerOrderByWithRelationInput[] = [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }];

async function find(id: string) {
  const b = await prisma.banner.findUnique({ where: { id } });
  if (!b) throw ApiError.notFound("Banner");
  return b;
}

async function nextPriority(placement: string) {
  const top = await prisma.banner.aggregate({ where: { placement }, _max: { priority: true } });
  return (top._max.priority ?? 0) + 1;
}

async function idsIn(placement: string) {
  return (await prisma.banner.findMany({ where: { placement }, select: { id: true }, orderBy: ORDER })).map((b) => b.id);
}

async function renumber(ids: string[]) {
  await prisma.$transaction(ids.map((id, i) => prisma.banner.update({ where: { id }, data: { priority: i + 1 } })));
}

export const bannersService = {
  async storeList(q: StoreBannersQuery, customerId?: string) {
    const [viewer, vars] = await Promise.all([resolveViewer(customerId), templateVars()]);
    const rows = await prisma.banner.findMany({
      where: { ...liveNow(), ...(q.placement ? { placement: q.placement } : {}), ...deviceWhere(q.device), audience: { in: placementAudiences(viewer) } },
      orderBy: ORDER,
    });
    return rows.map((b) => toStore(b, vars));
  },

  async list(q: BannerListQuery) {
    const scoped: Prisma.BannerWhereInput = {
      ...(q.placement ? { placement: q.placement } : {}),
      ...(q.device ? { device: q.device } : {}),
      ...(q.audience ? { audience: q.audience } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { message: { contains: q.q } }] } : {}),
    };
    const where: Prisma.BannerWhereInput = { ...scoped, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, groups, sums, byPlacement] = await Promise.all([
      prisma.banner.findMany({ where, orderBy: q.placement ? ORDER : [{ placement: "asc" }, ...ORDER], ...paging(q) }),
      prisma.banner.count({ where }),
      prisma.banner.groupBy({ by: ["status"], where: scoped, _count: { _all: true } }),
      prisma.banner.aggregate({ where: scoped, _sum: { impressions: true, clicks: true, dismissals: true } }),
      prisma.banner.groupBy({ by: ["placement", "status"], _count: { _all: true } }),
    ]);
    const tabs = statusTabs(groups);
    const impressions = sums._sum.impressions ?? 0;
    const clicks = sums._sum.clicks ?? 0;
    const dismissals = sums._sum.dismissals ?? 0;
    const placements = BANNER_PLACEMENTS.map((p) => {
      const g = byPlacement.filter((x) => x.placement === p);
      return { placement: p, total: g.reduce((s, x) => s + x._count._all, 0), live: g.find((x) => x.status === "live")?._count._all ?? 0 };
    });
    return withMeta(rows.map(toAdmin), {
      ...pageMeta(q, total), tabs, placements,
      kpis: { live: tabs.live, scheduled: tabs.scheduled, impressions, clicks, dismissals, ctr: ctr(impressions, clicks), dismissRate: ctr(impressions, dismissals) },
    });
  },

  async get(id: string) {
    return toAdmin(await find(id));
  },

  async create(b: BannerBody) {
    checkTemplate(b.message, b.cta);
    const status = effectiveStatus(b.status, b.startsAt, b.endsAt);
    const row = await prisma.banner.create({
      data: { ...b, status, priority: b.priority ?? (await nextPriority(b.placement)), icon: b.icon ?? null },
    });
    return toAdmin(row);
  },

  async update(id: string, patch: BannerPatch) {
    const cur = await find(id);
    checkTemplate(patch.message, patch.cta);
    const startsAt = patch.startsAt === undefined ? cur.startsAt : patch.startsAt;
    const endsAt = patch.endsAt === undefined ? cur.endsAt : patch.endsAt;
    const status = effectiveStatus(patch.status ?? cur.status, startsAt, endsAt);
    const moving = patch.placement && patch.placement !== cur.placement;
    const priority = patch.priority ?? (moving ? await nextPriority(patch.placement!) : undefined);
    const row = await prisma.banner.update({ where: { id }, data: { ...patch, status, priority } });
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  async setStatus(id: string, status: Banner["status"]) {
    const cur = await find(id);
    const row = await prisma.banner.update({ where: { id }, data: { status: effectiveStatus(status, cur.startsAt, cur.endsAt) } });
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  async duplicate(id: string) {
    const s = await find(id);
    const copy = await prisma.banner.create({
      data: {
        name: `${s.name} (copy)`, placement: s.placement, priority: await nextPriority(s.placement), status: "draft", device: s.device, audience: s.audience,
        message: s.message, cta: s.cta, linkTo: s.linkTo, bg: s.bg, fg: s.fg, accent: s.accent, style: s.style, icon: s.icon,
        dismissible: s.dismissible, startsAt: s.startsAt, endsAt: s.endsAt, notes: s.notes,
      },
    });
    return toAdmin(copy);
  },

  async remove(id: string) {
    const b = await find(id);
    await prisma.banner.delete({ where: { id } });
    return toAdmin(b);
  },

  /** drag & drop: the given ids become priority 1..n, the rest of the placement follows */
  async reorder(placement: string, ids: string[]) {
    await renumber(reordered(await idsIn(placement), ids));
    return (await prisma.banner.findMany({ where: { placement }, orderBy: ORDER })).map(toAdmin);
  },

  async move(id: string, direction: "up" | "down") {
    const b = await find(id);
    const next = moved(await idsIn(b.placement), id, direction);
    if (next) await renumber(next);
    return (await prisma.banner.findMany({ where: { placement: b.placement }, orderBy: ORDER })).map(toAdmin);
  },
};
