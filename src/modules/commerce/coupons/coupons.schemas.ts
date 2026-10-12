import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const couponBase = z.object({
    code: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only").transform((s) => s.toUpperCase()),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    type: z.enum(["percent", "fixed", "free_shipping", "bogo"]),
    /** percent / bogo: 1–100. fixed: kobo. free_shipping: 0 */
    value: z.number().int().min(0),
    status: z.enum(["active", "scheduled", "expired", "paused", "draft"]).default("draft"),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    minSubtotal: z.number().int().min(0).nullable().optional(),
    maxDiscount: z.number().int().min(0).nullable().optional(),
    usageLimit: z.number().int().min(1).nullable().optional(),
    perCustomerLimit: z.number().int().min(1).nullable().optional(),
    appliesTo: z.enum(["all", "categories", "brands", "products", "collections"]).default("all"),
    /** handles (or ids) of the categories / brands / products / collections */
    appliesToRefs: z.array(z.string().max(80)).max(500).default([]),
    eligibility: z.enum(["all", "new", "vip", "segment"]).default("all"),
    segmentId: z.string().max(64).nullable().optional(),
    stackable: z.boolean().default(false),
    autoApply: z.boolean().default(false),
    oncePerCustomer: z.boolean().default(false),
    channels: z.array(z.enum(["web", "mobile", "concierge"])).min(1).default(["web", "mobile"]),
    notes: z.string().max(2000).nullable().optional(),
  });

export const couponBody = couponBase
  .refine((c) => !(c.type === "percent" || c.type === "bogo") || (c.value >= 1 && c.value <= 100), { message: "Percent must be 1–100", path: ["value"] })
  .refine((c) => c.type !== "fixed" || c.value > 0, { message: "Enter an amount", path: ["value"] })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt > c.startsAt, { message: "End date must be after start date", path: ["endsAt"] });

export const couponPatch = patchOf(couponBase);

export const couponListQuery = pageQuery.extend({
  status: z.enum(["all", "active", "scheduled", "expired", "paused", "draft"]).default("all"),
  type: z.enum(["percent", "fixed", "free_shipping", "bogo"]).optional(),
});
export const statusBody = z.object({ status: z.enum(["active", "scheduled", "expired", "paused", "draft"]) });

export type CouponBody = z.infer<typeof couponBody>;
export type CouponPatch = z.infer<typeof couponPatch>;
export type CouponListQuery = z.infer<typeof couponListQuery>;
