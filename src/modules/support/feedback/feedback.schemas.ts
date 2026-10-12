import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const FEEDBACK_TYPES = ["idea", "bug", "praise"] as const;
export const FEEDBACK_STATUSES = ["new", "triaged", "done"] as const;

/** /account/feedback */
export const feedbackBody = z.object({
  type: z.enum(FEEDBACK_TYPES),
  area: z.string().trim().min(1).max(60).default("General"),
  message: z.string().trim().min(10, "Please add a little more detail").max(5000),
  /** "email me back" address (defaults to nothing: the account e-mail is on the row anyway) */
  email: z.union([z.email().trim().toLowerCase().max(190), z.literal("")]).optional(),
});

export const adminFeedbackQuery = pageQuery.extend({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  type: z.enum(FEEDBACK_TYPES).optional(),
  area: z.string().max(60).optional(),
});

export const feedbackStatusBody = z.object({ status: z.enum(FEEDBACK_STATUSES) });

export type FeedbackBody = z.infer<typeof feedbackBody>;
export type AdminFeedbackQuery = z.infer<typeof adminFeedbackQuery>;
export type FeedbackStatusBody = z.infer<typeof feedbackStatusBody>;
