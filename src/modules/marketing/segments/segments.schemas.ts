import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const FIELDS = ["spend", "orders", "aov", "concierge", "tier", "status", "country", "city", "tags", "marketingOptIn", "lastOrderAt", "createdAt"] as const;
const OPS = ["eq", "neq", "gt", "lt", "gte", "lte", "in", "contains", "within_days", "before_days"] as const;

/** spend / aov in kobo; lastOrderAt / createdAt values are days */
export const segmentRule = z.object({
  field: z.enum(FIELDS),
  op: z.enum(OPS),
  value: z.union([z.number(), z.string().max(200), z.boolean(), z.array(z.union([z.string().max(100), z.number()])).max(100)]),
});

const segmentBase = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Hex colour like #0f0f0f").default("#0f0f0f"),
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(segmentRule).max(30).default([]),
  pinned: z.boolean().default(false),
});

export const segmentBody = segmentBase;
export const segmentPatch = patchOf(segmentBase);
export const rulesBody = z.object({ match: z.enum(["all", "any"]).default("all"), rules: z.array(segmentRule).max(30) });

export const segmentListQuery = pageQuery.extend({
  pinned: z.enum(["true", "false"]).optional(),
  /** include the live customer count for each row (one COUNT per segment) */
  counts: z.enum(["true", "false"]).default("true"),
});
export const segmentCustomersQuery = pageQuery.extend({
  marketable: z.enum(["true", "false"]).optional(),
});

export type SegmentRule = z.infer<typeof segmentRule>;
export type SegmentBody = z.infer<typeof segmentBody>;
export type SegmentPatch = z.infer<typeof segmentPatch>;
export type RulesBody = z.infer<typeof rulesBody>;
export type SegmentListQuery = z.infer<typeof segmentListQuery>;
export type SegmentCustomersQuery = z.infer<typeof segmentCustomersQuery>;
