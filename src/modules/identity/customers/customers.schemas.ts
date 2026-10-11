import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const CUSTOMER_TABS = ["all", "active", "vip", "flagged", "blocked"] as const;
export const tierEnum = z.enum(["Standard", "Silver", "Gold", "Signature"]);
export const statusEnum = z.enum(["active", "vip", "flagged", "blocked"]);

export const customerListQuery = pageQuery.extend({
  tab: z.enum(CUSTOMER_TABS).default("all"),
  tier: tierEnum.optional(),
  /** spend | orders | createdAt | lastOrderAt, "-" prefix = descending (default "-createdAt") */
  sort: z.string().max(40).optional(),
});

export const statusBody = z.object({ status: statusEnum, reason: z.string().trim().max(300).optional() });
export const tierBody = z.object({ tier: tierEnum });
export const marketingBody = z.object({ optIn: z.boolean() });
export const noteBody = z.object({ body: z.string().trim().min(1).max(4000) });
export const tagBody = z.object({ tag: z.string().trim().min(1).max(40).transform((s) => s.toLowerCase()) });
export const walletAdjustBody = z.object({
  /** signed kobo (+ credit, − debit) */
  amount: z.number().int().refine((n) => n !== 0, "Amount can't be zero"),
  kind: z.enum(["credit", "adjustment"]).default("adjustment"),
  note: z.string().trim().min(3).max(300),
});

export const noteParams = z.object({ id: z.string().min(1).max(64), noteId: z.string().min(1).max(64) });
export const tagParams = z.object({ id: z.string().min(1).max(64), tag: z.string().min(1).max(40) });

export type CustomerListQuery = z.infer<typeof customerListQuery>;
export type StatusBody = z.infer<typeof statusBody>;
export type TierBody = z.infer<typeof tierBody>;
export type WalletAdjustBody = z.infer<typeof walletAdjustBody>;
