import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { DEVICES, STATUSES } from "../impressions/placements";
import { patchOf } from "@/core/http/patch-schema";

export const BANNER_PLACEMENTS = ["top_bar", "checkout", "cart_nudge", "category_ribbon", "product_ribbon", "concierge_strip"] as const;
export const BANNER_AUDIENCES = ["all", "guest", "member", "vip"] as const;
export const BANNER_STYLES = ["solid", "gradient", "outline"] as const;
export const BANNER_ICONS = ["sparkles", "gift", "truck", "flame", "crown", "none"] as const;

const colour = z.string().trim().min(1).max(191);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.coerce.date().nullable().optional();

/** fields without defaults (a PATCH must not reset omitted fields) */
const fields = {
  name: z.string().trim().min(1).max(120),
  placement: z.enum(BANNER_PLACEMENTS),
  /** 1 = shown first within the placement (omit on create → last) */
  priority: z.number().int().min(0).max(9999),
  status: z.enum(STATUSES),
  device: z.enum(DEVICES),
  audience: z.enum(BANNER_AUDIENCES),
  /** may contain {{freeShippingThreshold}} */
  message: z.string().trim().min(1).max(500),
  cta: text(80),
  linkTo: text(500),
  bg: colour,
  fg: colour,
  accent: colour,
  style: z.enum(BANNER_STYLES),
  icon: z.enum(BANNER_ICONS).nullable().optional(),
  dismissible: z.boolean(),
  startsAt: date,
  endsAt: date,
  notes: text(2000),
};

export const bannerBody = z.object({
  ...fields,
  priority: fields.priority.optional(),
  status: fields.status.default("draft"),
  device: fields.device.default("all"),
  audience: fields.audience.default("all"),
  bg: colour.default("#0f0f0f"),
  fg: colour.default("#faf6ea"),
  accent: colour.default("#c9a86a"),
  style: fields.style.default("solid"),
  dismissible: fields.dismissible.default(true),
});
export const bannerPatch = patchOf(z.object(fields));
export const bannerStatusBody = z.object({ status: z.enum(STATUSES) });
export const bannerReorderBody = z.object({ placement: z.enum(BANNER_PLACEMENTS), ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
export const moveBody = z.object({ direction: z.enum(["up", "down"]) });

export const bannerListQuery = pageQuery.extend({
  placement: z.enum(BANNER_PLACEMENTS).optional(),
  status: z.enum(STATUSES).optional(),
  device: z.enum(DEVICES).optional(),
  audience: z.enum(BANNER_AUDIENCES).optional(),
});

export const storeBannersQuery = z.object({
  placement: z.enum(BANNER_PLACEMENTS).optional(),
  device: z.enum(["mobile", "desktop"]).optional(),
});

export type BannerBody = z.infer<typeof bannerBody>;
export type BannerPatch = z.infer<typeof bannerPatch>;
export type BannerStatusBody = z.infer<typeof bannerStatusBody>;
export type BannerReorderBody = z.infer<typeof bannerReorderBody>;
export type MoveBody = z.infer<typeof moveBody>;
export type BannerListQuery = z.infer<typeof bannerListQuery>;
export type StoreBannersQuery = z.infer<typeof storeBannersQuery>;
