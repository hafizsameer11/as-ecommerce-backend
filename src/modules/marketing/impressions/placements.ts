/**
 * Shared rules for the storefront merchandising modules (banners, announcements, slots):
 * who sees what (audience + device), when (status + schedule), template variables, admin access.
 */
import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { formatNaira } from "@/core/utils/money";
import type { Permission } from "@/core/auth/permissions";
import type { DeviceTarget, PlacementStatus } from "@/generated/prisma/enums";
import { settingsService } from "@/modules/platform/settings/settings.service";

export const STATUSES = ["live", "scheduled", "paused", "draft", "expired"] as const;
export const DEVICES = ["all", "mobile", "desktop"] as const;

/**
 * Admin access: the admin app shows Banners, Homepage Slots and the Announcement Bar to the
 * marketing AND content_editor roles → either `marketing.manage` or `content.publish` is enough.
 */
export const MERCH_PERMISSIONS: Permission[] = ["marketing.manage", "content.publish"];
export function canMerchandise(req: Request, _res: Response, next: NextFunction) {
  if (!req.admin) throw ApiError.unauthenticated();
  if (!MERCH_PERMISSIONS.some((p) => req.admin!.permissions.has(p))) throw ApiError.forbidden();
  next();
}
export const MERCH_ACCESS_NOTE = "**Permission:** `marketing.manage` or `content.publish`";

// ── audience ──────────────────────────────────────────────────────────────

export type Viewer = { loggedIn: boolean; tier: "Standard" | "Silver" | "Gold" | "Signature" | null };

export async function resolveViewer(customerId?: string | null): Promise<Viewer> {
  if (!customerId) return { loggedIn: false, tier: null };
  const c = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { tier: true } });
  return c ? { loggedIn: true, tier: c.tier } : { loggedIn: false, tier: null };
}

const isVip = (v: Viewer) => v.tier === "Gold" || v.tier === "Signature";

/** Banner / Slot audience `all | guest | member | vip` (vip = Club Gold or Signature) */
export function placementAudiences(v: Viewer) {
  if (!v.loggedIn) return ["all", "guest"];
  return isVip(v) ? ["all", "member", "vip"] : ["all", "member"];
}

/** Announcement audience `everyone | guests | members | club_gold | club_signature` (club_gold = Gold and above) */
export function announcementAudiences(v: Viewer) {
  if (!v.loggedIn) return ["everyone", "guests"];
  const a = ["everyone", "members"];
  if (isVip(v)) a.push("club_gold");
  if (v.tier === "Signature") a.push("club_signature");
  return a;
}

/** `device=mobile` → items for all devices + mobile only; no device → every item (client picks by `device`) */
export const deviceWhere = (device?: "mobile" | "desktop") => (device ? { device: { in: ["all", device] as DeviceTarget[] } } : {});

// ── schedule ──────────────────────────────────────────────────────────────

/** live AND inside its window (safe even if the schedule job hasn't run yet) */
export const liveNow = (now = new Date()) => ({
  status: "live" as const,
  AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
});

/**
 * The status that is actually stored: asking for live/scheduled follows the dates
 * (future start → scheduled, otherwise live); a window that already ended can't go live.
 */
export function effectiveStatus(status: PlacementStatus, startsAt: Date | null | undefined, endsAt: Date | null | undefined, now = new Date()): PlacementStatus {
  if (startsAt && endsAt && endsAt <= startsAt) throw ApiError.badRequest("VALIDATION_FAILED", "The end date must be after the start date.");
  if (status !== "live" && status !== "scheduled") return status;
  if (endsAt && endsAt <= now) throw ApiError.badRequest("INVALID_STATE", "The end date has passed. Change the dates before publishing.");
  return startsAt && startsAt > now ? "scheduled" : "live";
}

// ── template variables ────────────────────────────────────────────────────

/** `{{freeShippingThreshold}}` in any shown text is filled from settings (shipping.freeShippingThreshold) */
export const TEMPLATE_VARS = ["freeShippingThreshold"] as const;
const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function checkTemplate(...texts: (string | null | undefined)[]) {
  const unknown = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(VAR_RE)) if (!(TEMPLATE_VARS as readonly string[]).includes(m[1])) unknown.add(m[1]);
  if (unknown.size)
    throw ApiError.badRequest("VALIDATION_FAILED", `Unknown variable ${[...unknown].map((u) => `{{${u}}}`).join(", ")}. Available: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(", ")}.`);
}

export type TemplateVars = Record<(typeof TEMPLATE_VARS)[number], string>;

export async function templateVars(): Promise<TemplateVars> {
  const shipping = await settingsService.get("shipping");
  return { freeShippingThreshold: formatNaira(shipping.freeShippingThreshold) };
}

export function render<T extends string | null | undefined>(text: T, vars: TemplateVars): T {
  if (!text) return text;
  return text.replace(VAR_RE, (all, k: string) => (k in vars ? vars[k as keyof TemplateVars] : all)) as T;
}

// ── admin list helpers ────────────────────────────────────────────────────

export const ctr = (impressions: number, clicks: number) => (impressions ? Math.round((clicks / impressions) * 10_000) / 100 : 0);

/** `{ all, live, scheduled, paused, draft, expired }` from a groupBy on status */
export function statusTabs(groups: { status: PlacementStatus; _count: { _all: number } }[]) {
  const tabs: Record<string, number> = { all: 0, live: 0, scheduled: 0, paused: 0, draft: 0, expired: 0 };
  for (const g of groups) {
    tabs[g.status] = g._count._all;
    tabs.all += g._count._all;
  }
  return tabs;
}

/** new order for a group after moving one id up/down (returns null at the edge) */
export function moved(ids: string[], id: string, direction: "up" | "down") {
  const i = ids.indexOf(id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** full order after a reorder request: the given ids first (in order), the rest keep their relative order */
export function reordered(current: string[], requested: string[]) {
  const unknown = requested.filter((id) => !current.includes(id));
  if (unknown.length) throw ApiError.badRequest("VALIDATION_FAILED", "Some items don't belong to this group.", { ids: unknown });
  return [...new Set(requested), ...current.filter((id) => !requested.includes(id))];
}

