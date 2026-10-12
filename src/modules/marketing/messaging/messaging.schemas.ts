import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const CHANNELS = ["email", "push", "sms", "whatsapp"] as const;
const CATEGORIES = ["transactional", "lifecycle", "concierge", "system"] as const;
const STATUSES = ["active", "draft", "paused"] as const;

export const templateListQuery = pageQuery.extend({
  channel: z.enum(CHANNELS).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(["all", ...STATUSES]).default("all"),
});

const text = (max: number) => z.string().max(max);
export const templatePatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  subject: text(300).nullable().optional(),
  preheader: text(300).nullable().optional(),
  body: z.string().min(1).max(20_000).optional(),
  /** CTA button label (admin UI `cta`) */
  ctaLabel: text(80).nullable().optional(),
  cta: text(80).nullable().optional(),
  /** CTA link, may use {{variables}} (admin UI `linkTo`) */
  linkTo: text(1000).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  trigger: text(200).optional(),
  notes: text(5000).nullable().optional(),
});
export const templateStatusBody = z.object({ status: z.enum(STATUSES) });

const vars = z.record(z.string().max(60), z.union([z.string().max(2000), z.number()])).default({});
/** preview the saved template, or unsaved edits passed in `draft` */
export const previewBody = z.object({
  vars,
  draft: templatePatch.pick({ subject: true, preheader: true, body: true, ctaLabel: true, cta: true, linkTo: true }).optional(),
});
/** email → `to` or the signed-in admin's email; sms/whatsapp → `to` phone required; push → `token` (optional, mock provider) */
export const testSendBody = z.object({
  vars,
  to: z.string().trim().max(200).optional(),
  token: z.string().max(1000).optional(),
});

// ── push blasts ──
const BLAST_STATUS = ["draft", "scheduled", "sending", "sent"] as const;
export const blastListQuery = pageQuery.extend({ status: z.enum(["all", ...BLAST_STATUS]).default("all") });
const blastBase = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  /** "all" = every customer with a push token; "segment" = customers of `segmentId` with a push token */
  audience: z.enum(["all", "segment"]).default("all"),
  segmentId: z.string().max(64).nullable().optional(),
  scheduledFor: z.coerce.date().nullable().optional(),
});
export const blastBody = blastBase
  .extend({ status: z.enum(["draft", "scheduled"]).default("draft") })
  .refine((b) => b.audience !== "segment" || !!b.segmentId, { message: "Choose a segment", path: ["segmentId"] })
  .refine((b) => b.status !== "scheduled" || !!b.scheduledFor, { message: "Pick a send time", path: ["scheduledFor"] });
export const blastPatch = blastBase.partial();
export const scheduleBody = z.object({ scheduledFor: z.coerce.date() });
export const pushOpenedBody = z.object({ blastId: z.string().min(1).max(64) });

export type TemplateListQuery = z.infer<typeof templateListQuery>;
export type TemplatePatch = z.infer<typeof templatePatch>;
export type PreviewBody = z.infer<typeof previewBody>;
export type TestSendBody = z.infer<typeof testSendBody>;
export type BlastListQuery = z.infer<typeof blastListQuery>;
export type BlastBody = z.infer<typeof blastBody>;
export type BlastPatch = z.infer<typeof blastPatch>;
