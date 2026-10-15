import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** ISO-2 preferred; admin UI may send "Nigeria" */
const country = z
  .string()
  .trim()
  .max(80)
  .optional()
  .transform((v) => {
    if (!v) return "NG";
    if (v.length === 2) return v.toUpperCase();
    if (/^nigeria$/i.test(v)) return "NG";
    return "NG";
  });

export const locationBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** optional on create — admin often adds the name first, then fills address */
  address: z.string().trim().max(190).default(""),
  city: z.string().trim().max(80).default(""),
  state: z.string().trim().max(80).default(""),
  country: country.default("NG"),
  phone: z.string().trim().max(30).default(""),
  hours: z.string().trim().max(190).default("Mon - Sat 10:00 - 19:00"),
  active: z.boolean().default(true),
  concierge: z.boolean().default(false),
  capacityPerDay: z.number().int().min(1).max(10_000).default(40),
});
export type LocationBody = z.infer<typeof locationBody>;

// ── bookings ──
export const PICKUP_STATUSES = ["scheduled", "ready", "collected", "no_show", "cancelled"] as const;
export const PICKUP_ACTIONS = ["ready", "collected", "no_show", "cancelled"] as const;

export const bookingListQuery = pageQuery.extend({
  tab: z.enum(["all", "today", ...PICKUP_STATUSES]).default("all"),
  locationId: z.string().max(64).optional(),
  /** a day in Lagos time, YYYY-MM-DD */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** `{ status }` (tests / Swagger) or `{ action, note }` (asl-admin) */
export const bookingAdvanceBody = z
  .object({
    status: z.enum(PICKUP_STATUSES).optional(),
    action: z.enum(PICKUP_ACTIONS).optional(),
    /** who collected it (name / ID shown) */
    collectedBy: z.string().trim().max(120).optional(),
    /** optional note; for collected, used as collectedBy when that field is omitted */
    note: z.string().trim().max(2000).optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.status && !b.action) {
      ctx.addIssue({ code: "custom", message: "Provide status or action (ready|collected|no_show|cancelled)", path: ["status"] });
    }
  })
  .transform((b) => {
    const status = (b.status ?? b.action)!;
    return {
      status,
      collectedBy: b.collectedBy ?? (status === "collected" && b.note ? b.note : undefined),
      note: b.note,
    };
  });
export const bookingNoteBody = z.object({ note: z.string().trim().max(2000) });
export const bookingRescheduleBody = z.object({
  scheduledAt: z.coerce.date(),
  locationId: z.string().max(64).optional(),
});

export type BookingListQuery = z.infer<typeof bookingListQuery>;
export type BookingAdvanceBody = z.infer<typeof bookingAdvanceBody>;
export type BookingRescheduleBody = z.infer<typeof bookingRescheduleBody>;
