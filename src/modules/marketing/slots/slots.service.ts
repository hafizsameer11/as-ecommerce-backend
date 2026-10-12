/**
 * Page slots (asl-admin /slots): heroes, promo banners, grids, carousels, editorials and countdowns placed on
 * home / shop / sales / concierge / brands. Pinned first, then position 1..n. `GET /store/home` uses `forPage("home")`.
 */
import type { Prisma, Slot } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import {
  checkTemplate, ctr, deviceWhere, effectiveStatus, liveNow, moved, placementAudiences, render, reordered, resolveViewer, statusTabs,
  templateVars, type TemplateVars,
} from "../impressions/placements";
import { SLOT_PAGES, type SlotBody, type SlotListQuery, type SlotPatch, type StoreSlotsQuery } from "./slots.schemas";

const toAdmin = (s: Slot) => ({
  id: s.id, name: s.name, page: s.page, position: s.position, type: s.type, status: s.status, device: s.device, audience: s.audience,
  eyebrow: s.eyebrow, headline: s.headline, subhead: s.subhead, cta: s.cta, linkTo: s.linkTo, secondaryCta: s.secondaryCta, secondaryLinkTo: s.secondaryLinkTo,
  imageUrl: s.imageUrl, imageColor: s.imageColor, accent: s.accent, startsAt: s.startsAt, endsAt: s.endsAt, pinned: s.pinned, notes: s.notes,
  impressions: s.impressions, clicks: s.clicks, ctr: ctr(s.impressions, s.clicks), revenue: Number(s.revenue),
  createdAt: s.createdAt, updatedAt: s.updatedAt,
});

/** what the storefront renders (template variables filled) */
const toStore = (s: Slot, vars: TemplateVars) => ({
  id: s.id, page: s.page, position: s.position, type: s.type, device: s.device, audience: s.audience, pinned: s.pinned,
  eyebrow: render(s.eyebrow, vars), headline: render(s.headline, vars), subhead: render(s.subhead, vars),
  cta: render(s.cta, vars), linkTo: s.linkTo, secondaryCta: render(s.secondaryCta, vars), secondaryLinkTo: s.secondaryLinkTo,
  imageUrl: s.imageUrl, imageColor: s.imageColor, accent: s.accent, startsAt: s.startsAt, endsAt: s.endsAt,
});
export type StoreSlot = ReturnType<typeof toStore>;

/** storefront order: pinned first, then position */
const STORE_ORDER: Prisma.SlotOrderByWithRelationInput[] = [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }, { id: "asc" }];
/** position order (what reorder / move work on) */
const ORDER: Prisma.SlotOrderByWithRelationInput[] = [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }];

async function find(id: string) {
  const s = await prisma.slot.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound("Slot");
  return s;
}

async function nextPosition(page: string) {
  const top = await prisma.slot.aggregate({ where: { page }, _max: { position: true } });
  return (top._max.position ?? 0) + 1;
}

async function idsIn(page: string) {
  return (await prisma.slot.findMany({ where: { page }, select: { id: true }, orderBy: ORDER })).map((s) => s.id);
}

async function renumber(ids: string[]) {
  await prisma.$transaction(ids.map((id, i) => prisma.slot.update({ where: { id }, data: { position: i + 1 } })));
}

const pageRows = async (page: string) => (await prisma.slot.findMany({ where: { page }, orderBy: ORDER })).map(toAdmin);

export const slotsService = {
  /** live slots of a page for this caller (used by GET /store/slots and GET /store/home) */
  async forPage(page: StoreSlotsQuery["page"], customerId?: string, device?: "mobile" | "desktop") {
    const [viewer, vars] = await Promise.all([resolveViewer(customerId), templateVars()]);
    const rows = await prisma.slot.findMany({
      where: { ...liveNow(), page, ...deviceWhere(device), audience: { in: placementAudiences(viewer) } },
      orderBy: STORE_ORDER,
    });
    return rows.map((s) => toStore(s, vars));
  },

  storeList(q: StoreSlotsQuery, customerId?: string) {
    return this.forPage(q.page, customerId, q.device);
  },

  async list(q: SlotListQuery) {
    const scoped: Prisma.SlotWhereInput = {
      ...(q.slotPage ? { page: q.slotPage } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.device ? { device: q.device } : {}),
      ...(q.audience ? { audience: q.audience } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { headline: { contains: q.q } }, { subhead: { contains: q.q } }] } : {}),
    };
    const where: Prisma.SlotWhereInput = { ...scoped, ...(q.status ? { status: q.status } : {}) };
    const [rows, total, groups, sums, byPage] = await Promise.all([
      prisma.slot.findMany({ where, orderBy: q.slotPage ? ORDER : [{ page: "asc" }, ...ORDER], ...paging(q) }),
      prisma.slot.count({ where }),
      prisma.slot.groupBy({ by: ["status"], where: scoped, _count: { _all: true } }),
      prisma.slot.aggregate({ where: scoped, _sum: { impressions: true, clicks: true, revenue: true } }),
      prisma.slot.groupBy({ by: ["page", "status"], _count: { _all: true } }),
    ]);
    const tabs = statusTabs(groups);
    const impressions = sums._sum.impressions ?? 0;
    const clicks = sums._sum.clicks ?? 0;
    const pages = SLOT_PAGES.map((p) => {
      const g = byPage.filter((x) => x.page === p);
      return { page: p, total: g.reduce((s, x) => s + x._count._all, 0), live: g.find((x) => x.status === "live")?._count._all ?? 0 };
    });
    return withMeta(rows.map(toAdmin), {
      ...pageMeta(q, total), tabs, pages,
      kpis: { live: tabs.live, scheduled: tabs.scheduled, impressions, clicks, ctr: ctr(impressions, clicks), revenue: Number(sums._sum.revenue ?? 0) },
    });
  },

  async get(id: string) {
    return toAdmin(await find(id));
  },

  async create(b: SlotBody) {
    checkTemplate(b.eyebrow, b.headline, b.subhead, b.cta, b.secondaryCta);
    const status = effectiveStatus(b.status, b.startsAt, b.endsAt);
    const row = await prisma.slot.create({ data: { ...b, status, position: b.position ?? (await nextPosition(b.page)) } });
    if (row.imageUrl) await mediaService.syncUsage("slot", row.id, [row.imageUrl]);
    return toAdmin(row);
  },

  async update(id: string, patch: SlotPatch) {
    const cur = await find(id);
    checkTemplate(patch.eyebrow, patch.headline, patch.subhead, patch.cta, patch.secondaryCta);
    const startsAt = patch.startsAt === undefined ? cur.startsAt : patch.startsAt;
    const endsAt = patch.endsAt === undefined ? cur.endsAt : patch.endsAt;
    const status = effectiveStatus(patch.status ?? cur.status, startsAt, endsAt);
    const moving = patch.page && patch.page !== cur.page;
    const position = patch.position ?? (moving ? await nextPosition(patch.page!) : undefined);
    const row = await prisma.slot.update({ where: { id }, data: { ...patch, status, position } });
    if (patch.imageUrl !== undefined) await mediaService.syncUsage("slot", id, [row.imageUrl]);
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  /** upload into the media library (folder hero / campaigns) and use it as the slot image */
  async uploadImage(id: string, file: UploadInput | undefined, folder: string, by: string, altText = "") {
    const cur = await find(id);
    if (!file) throw ApiError.badRequest("VALIDATION_FAILED", "Attach an image in the `file` field.");
    const asset = await mediaService.upload(file, folder, by, altText || cur.headline.slice(0, 191));
    const row = await prisma.slot.update({ where: { id }, data: { imageUrl: asset.url } });
    await mediaService.syncUsage("slot", id, [asset.url]);
    return { before: toAdmin(cur), after: toAdmin(row), asset: { id: asset.id, url: asset.url, variants: asset.variants } };
  },

  async setStatus(id: string, status: Slot["status"]) {
    const cur = await find(id);
    const row = await prisma.slot.update({ where: { id }, data: { status: effectiveStatus(status, cur.startsAt, cur.endsAt) } });
    return { before: toAdmin(cur), after: toAdmin(row) };
  },

  async togglePin(id: string) {
    const cur = await find(id);
    return toAdmin(await prisma.slot.update({ where: { id }, data: { pinned: !cur.pinned } }));
  },

  async duplicate(id: string) {
    const s = await find(id);
    const copy = await prisma.slot.create({
      data: {
        name: `${s.name} (copy)`, page: s.page, position: await nextPosition(s.page), type: s.type, status: "draft", device: s.device, audience: s.audience,
        eyebrow: s.eyebrow, headline: s.headline, subhead: s.subhead, cta: s.cta, linkTo: s.linkTo, secondaryCta: s.secondaryCta, secondaryLinkTo: s.secondaryLinkTo,
        imageUrl: s.imageUrl, imageColor: s.imageColor, accent: s.accent, startsAt: s.startsAt, endsAt: s.endsAt, pinned: false, notes: s.notes,
      },
    });
    if (copy.imageUrl) await mediaService.syncUsage("slot", copy.id, [copy.imageUrl]);
    return toAdmin(copy);
  },

  async remove(id: string) {
    const s = await find(id);
    await prisma.slot.delete({ where: { id } });
    await mediaService.syncUsage("slot", id, []);
    return toAdmin(s);
  },

  /** drag & drop: the given ids become positions 1..n, the rest of the page follows */
  async reorder(page: string, ids: string[]) {
    await renumber(reordered(await idsIn(page), ids));
    return pageRows(page);
  },

  async move(id: string, direction: "up" | "down") {
    const s = await find(id);
    const next = moved(await idsIn(s.page), id, direction);
    if (next) await renumber(next);
    return pageRows(s.page);
  },
};
