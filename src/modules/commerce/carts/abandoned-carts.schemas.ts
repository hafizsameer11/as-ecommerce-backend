import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const CART_STAGES = ["all", "just_abandoned", "reminder_1", "reminder_2", "recovered", "lost"] as const;

export const abandonedListQuery = pageQuery.extend({
  stage: z.enum(CART_STAGES).default("all"),
});

export const reminderChannel = z.enum(["email", "push"]);
export const remindBody = z.object({ channel: reminderChannel.default("email") });
export const remindBulkBody = z.object({
  /** omit to remind every abandoned cart with an email */
  ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
});

export const recoveryRule = z.object({
  /** 1 = first reminder, 2 = second … */
  stage: z.number().int().min(1).max(5),
  /** minutes after the cart was abandoned */
  delayMinutes: z.number().int().min(5).max(30 * 24 * 60),
  channel: reminderChannel.default("email"),
  templateCode: z.string().trim().min(1).max(80).default("cart.reminder"),
  enabled: z.boolean().default(true),
});
export const recoveryRulesBody = z.object({
  rules: z
    .array(recoveryRule)
    .max(5)
    .refine((rs) => new Set(rs.map((r) => r.stage)).size === rs.length, "Each reminder stage can only appear once")
    .refine((rs) => {
      const sorted = [...rs].sort((a, b) => a.stage - b.stage);
      return sorted.every((r, i) => i === 0 || r.delayMinutes > sorted[i - 1]!.delayMinutes);
    }, "Each reminder must come later than the one before it"),
});

export type AbandonedListQuery = z.infer<typeof abandonedListQuery>;
export type ReminderChannel = z.infer<typeof reminderChannel>;
export type RecoveryRulesBody = z.infer<typeof recoveryRulesBody>;
