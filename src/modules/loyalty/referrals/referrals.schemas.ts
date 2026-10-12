import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { settingsSchemas } from "@/modules/platform/settings/settings.defaults";
import { patchOf } from "@/core/http/patch-schema";

export const REFERRAL_STATUSES = ["pending", "qualified", "rewarded", "expired", "flagged", "rejected"] as const;
export const CHANNELS = ["link", "whatsapp", "email", "sms", "instagram"] as const;

export const codeParam = z.object({ code: z.string().trim().min(2).max(40) });
export const clickBody = z.object({ channel: z.enum(CHANNELS).optional() }).default({});

export const referralListQuery = pageQuery.extend({
  status: z.enum(["all", ...REFERRAL_STATUSES]).default("all"),
  channel: z.enum(CHANNELS).optional(),
  advocateId: z.string().max(64).optional(),
});
export const advocateListQuery = pageQuery.extend({
  status: z.enum(["all", "active", "paused", "banned"]).default("all"),
  tier: z.enum(["Standard", "Silver", "Gold", "Signature"]).optional(),
  sort: z.enum(["revenue", "qualified", "clicks", "recent"]).default("revenue"),
  /** false: every customer (each one has a code); true (default): only advocates with clicks or sign-ups */
  activeOnly: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});
export const advocateStatusBody = z.object({ status: z.enum(["active", "paused", "banned"]) });
export const noteBody = z.object({ note: z.string().trim().max(500).optional() }).default({});
export const configBody = patchOf(settingsSchemas.referrals);

export type ReferralListQuery = z.infer<typeof referralListQuery>;
export type AdvocateListQuery = z.infer<typeof advocateListQuery>;
export type ConfigBody = z.infer<typeof configBody>;
