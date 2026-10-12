import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

export const notifyMeBody = z.object({ size: z.string().max(20).optional() });
export const notifyMeQuery = z.object({ size: z.string().optional() });

export type NotifyMeBody = z.infer<typeof notifyMeBody>;
export type NotifyMeQuery = z.infer<typeof notifyMeQuery>;

// ── reservations (store) ──
const payFields = {
  method: z.enum(["card", "bank_transfer"]).default("card"),
  savedMethodId: z.string().max(64).nullable().optional(),
  returnUrl: z.string().url().max(500).nullable().optional(),
};

export const reserveBody = z.object({
  size: z.string().trim().max(20).nullable().optional(),
  /** multi-colour products: defaults to the first colour (same as the product page) */
  color: z.string().trim().max(60).nullable().optional(),
  ...payFields,
});
export const payBalanceBody = z.object({
  /** saved address for delivery (default: the account's default address) */
  addressId: z.string().max(64).optional(),
  ...payFields,
});
export const reservationRef = z.object({ id: z.string().min(1).max(64) });
export const myReservationsQuery = pageQuery.extend({ tab: z.enum(["all", "active", "past"]).default("all") });
export const cancelReservationBody = z.object({ reason: z.string().trim().max(300).optional() });

export type ReserveBody = z.infer<typeof reserveBody>;
export type PayBalanceBody = z.infer<typeof payBalanceBody>;
export type MyReservationsQuery = z.infer<typeof myReservationsQuery>;
export type CancelReservationBody = z.infer<typeof cancelReservationBody>;

// ── admin ──
export const adminDropsQuery = pageQuery.extend({ tab: z.enum(["all", "upcoming", "live", "sold_out", "ended"]).default("all") });
export const createDropBody = z.object({
  /** product id or handle */
  productId: z.string().min(1).max(190),
  releaseAt: z.coerce.date(),
  allocation: z.number().int().min(1).max(100_000),
  /** default: settings drops.depositPctDefault */
  depositPct: z.number().int().min(1).max(100).optional(),
  teaser: z.string().trim().max(2000).nullable().optional(),
});
export const updateDropBody = patchOf(createDropBody.omit({ productId: true }));
export const adminReservationsQuery = pageQuery.extend({
  tab: z.enum(["all", "pending_deposit", "reserved", "balance_paid", "cancelled", "expired"]).default("all"),
});
export const adminCancelReservationBody = z.object({
  reason: z.string().trim().min(2).max(300),
  /** where the deposit goes; "none" keeps it (journaled as forfeited) */
  refundTo: z.enum(["original", "wallet", "none"]).default("original"),
});
export const dropReservationParams = z.object({ id: z.string().min(1).max(64), rid: z.string().min(1).max(64) });

export type AdminDropsQuery = z.infer<typeof adminDropsQuery>;
export type CreateDropBody = z.infer<typeof createDropBody>;
export type UpdateDropBody = z.infer<typeof updateDropBody>;
export type AdminReservationsQuery = z.infer<typeof adminReservationsQuery>;
export type AdminCancelReservationBody = z.infer<typeof adminCancelReservationBody>;
