import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const status = z.enum(["scheduled", "in_transit", "paid", "failed", "on_hold"]);
const money = z.number().int().min(0).max(2_000_000_000);

export const payoutListQuery = pageQuery.extend({
  status: status.optional(),
  provider: z.string().trim().max(40).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const payoutBody = z.object({
  provider: z.string().trim().min(2).max(40),
  reference: z.string().trim().min(2).max(120).optional(),
  gross: money,
  fees: money.default(0),
  refunds: money.default(0),
  /** signed kobo (chargebacks −, reserve releases +) */
  adjustments: z.number().int().min(-2_000_000_000).max(2_000_000_000).default(0),
  scheduledAt: z.coerce.date(),
  status: z.enum(["scheduled", "in_transit"]).default("scheduled"),
  bankName: z.string().trim().min(2).max(80).optional(),
  bankAccountMasked: z.string().trim().min(4).max(20).optional(),
  bankAccountName: z.string().trim().min(2).max(120).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export const payoutPatch = z.object({
  notes: z.string().trim().max(2000).nullable().optional(),
  scheduledAt: z.coerce.date().optional(),
});
export const failBody = z.object({ reason: z.string().trim().min(3).max(300) });
export const holdBody = z.object({ note: z.string().trim().min(3).max(2000) });

export type PayoutListQuery = z.infer<typeof payoutListQuery>;
export type PayoutBody = z.infer<typeof payoutBody>;
export type PayoutPatch = z.infer<typeof payoutPatch>;
