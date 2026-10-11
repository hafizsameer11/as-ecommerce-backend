import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const locationBody = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(3).max(190),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  country: z.string().trim().length(2).default("NG"),
  phone: z.string().trim().min(7).max(30),
  hours: z.string().trim().max(190),
  active: z.boolean().default(true),
  concierge: z.boolean().default(false),
  capacityPerDay: z.number().int().min(1).max(10_000).default(40),
});
export type LocationBody = z.infer<typeof locationBody>;

// ── bookings ──
export const PICKUP_STATUSES = ["scheduled", "ready", "collected", "no_show", "cancelled"] as const;

export const bookingListQuery = pageQuery.extend({
  tab: z.enum(["all", "today", ...PICKUP_STATUSES]).default("all"),
  locationId: z.string().max(64).optional(),
  /** a day in Lagos time, YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const bookingAdvanceBody = z.object({
  status: z.enum(PICKUP_STATUSES),
  /** who collected it (name / ID shown) */
  collectedBy: z.string().trim().max(120).optional(),
});
export const bookingNoteBody = z.object({ note: z.string().trim().max(2000) });
export const bookingRescheduleBody = z.object({
  scheduledAt: z.coerce.date(),
  locationId: z.string().max(64).optional(),
});

export type BookingListQuery = z.infer<typeof bookingListQuery>;
export type BookingAdvanceBody = z.infer<typeof bookingAdvanceBody>;
export type BookingRescheduleBody = z.infer<typeof bookingRescheduleBody>;
