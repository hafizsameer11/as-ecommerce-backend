import { z } from "zod";

export const reviewStatus = z.enum(["pending", "published", "rejected", "flagged"]);

export const productReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10),
  sort: z.enum(["recent", "helpful", "highest", "lowest"]).default("recent"), rating: z.coerce.number().int().min(1).max(5).optional(),
});

export const reviewBody = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(10, "Please add a little more detail").max(4000),
  size: z.string().max(20).optional(),
  fit: z.enum(["runs_small", "true_to_size", "runs_large"]).optional(),
});

export const adminReviewsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
  status: reviewStatus.optional(), rating: z.coerce.number().int().min(1).max(5).optional(), q: z.string().optional(), product: z.string().optional(),
});
export const reviewStatusBody = z.object({ status: reviewStatus, reason: z.string().max(200).optional() });
export const reviewBulkBody = z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(["publish", "reject", "flag", "delete"]) });
export const reviewReplyBody = z.object({ body: z.string().trim().min(1).max(2000) });

export type ProductReviewsQuery = z.infer<typeof productReviewsQuery>;
export type ReviewBody = z.infer<typeof reviewBody>;
export type AdminReviewsQuery = z.infer<typeof adminReviewsQuery>;
export type ReviewStatusBody = z.infer<typeof reviewStatusBody>;
export type ReviewBulkBody = z.infer<typeof reviewBulkBody>;
export type ReviewReplyBody = z.infer<typeof reviewReplyBody>;
