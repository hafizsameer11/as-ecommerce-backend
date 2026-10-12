import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const CAMPAIGN_CHANNELS = ["email", "push", "sms", "whatsapp", "inapp"] as const;
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "paused", "archived"] as const;
const GOALS = ["awareness", "conversion", "retention", "winback", "launch"] as const;

const utm = z.object({ source: z.string().max(60), medium: z.string().max(60), campaign: z.string().max(100) });
const cta = z.object({ label: z.string().max(80), url: z.string().max(1000) });

const campaignBase = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().max(300).default(""),
  preheader: z.string().max(300).nullable().optional(),
  channel: z.enum(CAMPAIGN_CHANNELS).default("email"),
  goal: z.enum(GOALS).default("conversion"),
  /** null = all customers (opt-in rules per channel still apply) */
  segmentId: z.string().max(64).nullable().optional(),
  /** plain text; {{firstName}}, {{lastName}}, {{name}}, {{email}} are filled per recipient */
  body: z.string().max(20_000).default(""),
  ctaLabel: z.string().max(80).nullable().optional(),
  /** relative ("/shop") or absolute on the storefront's host */
  ctaUrl: z.string().max(1000).nullable().optional(),
  /** admin UI shape { label, url } — same as ctaLabel / ctaUrl */
  cta: cta.optional(),
  utm: utm.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  pinned: z.boolean().default(false),
  scheduledAt: z.coerce.date().nullable().optional(),
});

export const campaignBody = campaignBase;
export const campaignPatch = campaignBase.partial();

export const campaignListQuery = pageQuery.extend({
  status: z.enum(["all", ...CAMPAIGN_STATUSES]).default("all"),
  channel: z.enum(CAMPAIGN_CHANNELS).optional(),
  segmentId: z.string().max(64).optional(),
});

/** schedule (needs scheduledAt) · unschedule · pause · resume · archive · unarchive */
export const campaignStatusBody = z.object({
  action: z.enum(["schedule", "unschedule", "pause", "resume", "archive", "unarchive"]),
  scheduledAt: z.coerce.date().optional(),
});

/** email: `to` or the signed-in admin's email · sms/whatsapp: `to` phone · push: optional test token · inapp: `customerId` */
export const sendTestBody = z.object({
  to: z.string().trim().max(200).optional(),
  token: z.string().max(1000).optional(),
  customerId: z.string().max(64).optional(),
});

export const tokenParam = z.object({ token: z.string().min(1).max(64) });
export const clickQuery = z.object({ u: z.string().max(2000).optional() });

export type CampaignBody = z.infer<typeof campaignBody>;
export type CampaignPatch = z.infer<typeof campaignPatch>;
export type CampaignListQuery = z.infer<typeof campaignListQuery>;
export type CampaignStatusBody = z.infer<typeof campaignStatusBody>;
export type SendTestBody = z.infer<typeof sendTestBody>;
