import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { DEVICES, STATUSES } from "../impressions/placements";
import { patchOf } from "@/core/http/patch-schema";

export const SLOT_PAGES = ["home", "shop", "sales", "concierge", "brands"] as const;
export const SLOT_TYPES = ["hero", "banner", "grid", "carousel", "editorial", "countdown"] as const;
export const SLOT_AUDIENCES = ["all", "guest", "member", "vip"] as const;
/** media library folders a slot image can be uploaded into */
export const SLOT_IMAGE_FOLDERS = ["hero", "campaigns"] as const;

const colour = z.string().trim().min(1).max(191);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.coerce.date().nullable().optional();
/** absolute URL or a site path (e.g. a media-library URL) */
const imageUrl = z.string().trim().max(1024).refine((v) => /^(https?:\/\/|\/)/.test(v), "Use an https:// URL or a /path").nullable().optional();

/** fields without defaults (a PATCH must not reset omitted fields) */
const fields = {
  name: z.string().trim().min(1).max(120),
  page: z.enum(SLOT_PAGES),
  /** 1 = first on the page (omit on create → last) */
  position: z.number().int().min(0).max(9999),
  type: z.enum(SLOT_TYPES),
  status: z.enum(STATUSES),
  device: z.enum(DEVICES),
  audience: z.enum(SLOT_AUDIENCES),
  eyebrow: text(60),
  /** may contain {{freeShippingThreshold}}; "\n" = line break */
  headline: z.string().trim().min(1).max(191),
  subhead: text(191),
  cta: text(80),
  linkTo: text(191),
  secondaryCta: text(80),
  secondaryLinkTo: text(191),
  imageUrl,
  imageColor: colour.nullable().optional(),
  accent: colour.nullable().optional(),
  startsAt: date,
  endsAt: date,
  pinned: z.boolean(),
  notes: text(2000),
};

export const slotBody = z.object({
  ...fields,
  position: fields.position.optional(),
  status: fields.status.default("draft"),
  device: fields.device.default("all"),
  audience: fields.audience.default("all"),
  pinned: fields.pinned.default(false),
});
export const slotPatch = patchOf(z.object(fields));
export const slotStatusBody = z.object({ status: z.enum(STATUSES) });
export const slotReorderBody = z.object({ page: z.enum(SLOT_PAGES), ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
export const slotImageBody = z.object({ folder: z.enum(SLOT_IMAGE_FOLDERS).default("hero"), altText: z.string().trim().max(191).optional() });

export const slotListQuery = pageQuery.extend({
  /** storefront page (`page` is the pagination page) */
  slotPage: z.enum(SLOT_PAGES).optional(),
  status: z.enum(STATUSES).optional(),
  type: z.enum(SLOT_TYPES).optional(),
  device: z.enum(DEVICES).optional(),
  audience: z.enum(SLOT_AUDIENCES).optional(),
});

export const storeSlotsQuery = z.object({
  page: z.enum(SLOT_PAGES).default("home"),
  device: z.enum(["mobile", "desktop"]).optional(),
});

export type SlotBody = z.infer<typeof slotBody>;
export type SlotPatch = z.infer<typeof slotPatch>;
export type SlotStatusBody = z.infer<typeof slotStatusBody>;
export type SlotReorderBody = z.infer<typeof slotReorderBody>;
export type SlotImageBody = z.infer<typeof slotImageBody>;
export type SlotListQuery = z.infer<typeof slotListQuery>;
export type StoreSlotsQuery = z.infer<typeof storeSlotsQuery>;
