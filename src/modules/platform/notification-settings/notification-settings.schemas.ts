import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { settingsSchemas } from "@/modules/platform/settings/settings.defaults";

export const STAFF_CHANNELS = ["email", "push", "in_app", "slack", "sms"] as const;
export type StaffChannel = (typeof STAFF_CHANNELS)[number];
export const RULE_PRIORITIES = ["low", "normal", "high", "critical"] as const;
export const ADMIN_ROLES = [
  "super_admin", "ops_manager", "catalog_manager", "concierge_agent", "support", "marketing", "finance", "content_editor", "analyst",
] as const;

export const ruleIdParam = z.object({ id: z.string().min(1).max(64) });
export const ruleChannelParam = ruleIdParam.extend({ channel: z.enum(STAFF_CHANNELS) });
export const channelParam = z.object({ channel: z.enum(STAFF_CHANNELS) });

/** role id or e-mail address */
const recipient = z.string().trim().max(190).refine((v) => (ADMIN_ROLES as readonly string[]).includes(v) || z.email().safeParse(v).success, {
  message: "Use a role id (e.g. ops_manager) or an e-mail address",
});

export const rulePatch = z.object({
  enabled: z.boolean().optional(),
  channels: z.object(Object.fromEntries(STAFF_CHANNELS.map((c) => [c, z.boolean()])) as Record<StaffChannel, z.ZodBoolean>).partial().optional(),
  priority: z.enum(RULE_PRIORITIES).optional(),
  recipients: z.array(recipient).max(30).optional(),
});

const staff = settingsSchemas.staffAlerts.shape;
export const channelsPatch = z.object({
  email: staff.channels.shape.email.partial().optional(),
  push: staff.channels.shape.push.partial().optional(),
  slack: staff.channels.shape.slack.partial().optional(),
  sms: staff.channels.shape.sms.partial().optional(),
});
export const quietHoursPatch = staff.quietHours.partial();
export const digestPatch = staff.digest.partial();

export const bellQuery = pageQuery.extend({
  unread: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export type RulePatch = z.infer<typeof rulePatch>;
export type ChannelsPatch = z.infer<typeof channelsPatch>;
export type QuietHoursPatch = z.infer<typeof quietHoursPatch>;
export type DigestPatch = z.infer<typeof digestPatch>;
export type BellQuery = z.infer<typeof bellQuery>;
