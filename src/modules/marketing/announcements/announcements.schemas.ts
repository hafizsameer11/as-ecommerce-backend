import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { DEVICES, STATUSES } from "../impressions/placements";
import { patchOf } from "@/core/http/patch-schema";

export const ANN_PLACEMENTS = ["site_top", "checkout_top", "admin_top"] as const;
export const ANN_AUDIENCES = ["everyone", "guests", "members", "club_gold", "club_signature"] as const;
export const ANN_STYLES = ["solid", "gradient", "outline", "minimal"] as const;

/** hex when style=solid; a CSS gradient when style=gradient */
const colour = z.string().trim().min(1).max(191);
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const date = z.coerce.date().nullable().optional();

/** fields without defaults (a PATCH must not reset omitted fields) */
const fields = {
  title: z.string().trim().min(1).max(120),
  /** may contain {{freeShippingThreshold}} */
  message: z.string().trim().min(1).max(500),
  emoji: text(16),
  ctaLabel: text(80),
  ctaHref: text(500),
  style: z.enum(ANN_STYLES),
  bg: colour,
  fg: colour,
  placement: z.enum(ANN_PLACEMENTS),
  audience: z.enum(ANN_AUDIENCES),
  device: z.enum(DEVICES),
  dismissible: z.boolean(),
  /** higher = shown first when several qualify */
  priority: z.number().int().min(0).max(9999),
  status: z.enum(STATUSES),
  startsAt: date,
  endsAt: date,
};

export const announcementBody = z.object({
  ...fields,
  title: fields.title.default("New announcement"),
  style: fields.style.default("solid"),
  bg: colour.default("#0d0d0d"),
  fg: colour.default("#ffffff"),
  placement: fields.placement.default("site_top"),
  audience: fields.audience.default("everyone"),
  device: fields.device.default("all"),
  dismissible: fields.dismissible.default(true),
  priority: fields.priority.default(1),
  /** the admin creates announcements paused, then publishes */
  status: fields.status.default("paused"),
});
export const announcementPatch = patchOf(z.object(fields));
export const announcementStatusBody = z.object({ status: z.enum(STATUSES) });

export const announcementListQuery = pageQuery.extend({
  placement: z.enum(ANN_PLACEMENTS).optional(),
  status: z.enum(STATUSES).optional(),
  audience: z.enum(ANN_AUDIENCES).optional(),
});

export const storeAnnouncementsQuery = z.object({
  placement: z.enum(["site_top", "checkout_top"]).optional(),
  device: z.enum(["mobile", "desktop"]).optional(),
});

export type AnnouncementBody = z.infer<typeof announcementBody>;
export type AnnouncementPatch = z.infer<typeof announcementPatch>;
export type AnnouncementStatusBody = z.infer<typeof announcementStatusBody>;
export type AnnouncementListQuery = z.infer<typeof announcementListQuery>;
export type StoreAnnouncementsQuery = z.infer<typeof storeAnnouncementsQuery>;
