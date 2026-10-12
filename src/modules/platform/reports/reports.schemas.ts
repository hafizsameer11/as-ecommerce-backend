import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

export const REPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const REPORT_CATEGORIES = ["sales", "finance", "customers", "catalog", "concierge", "operations", "tax"] as const;
export const SCHEDULES = ["off", "daily", "weekly", "monthly"] as const;
export type Schedule = (typeof SCHEDULES)[number];
export const GENERATOR_KEYS = [
  "sales_summary", "vat_report", "wallet_liabilities", "inventory_valuation", "concierge_pipeline", "customer_list", "orders_export",
] as const;
export type GeneratorKey = (typeof GENERATOR_KEYS)[number];

/** period presets (Lagos days); explicit from/to win */
export const reportParams = z.object({
  range: z.enum(["7d", "14d", "30d", "90d", "12m", "mtd", "last_month", "yesterday"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).refine((p) => !p.from || !p.to || p.from <= p.to, { message: "`from` must be before `to`", path: ["to"] });
export type ReportParams = z.infer<typeof reportParams>;

const reportBase = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  generator: z.enum(GENERATOR_KEYS),
  /** defaults to the generator's category */
  category: z.enum(REPORT_CATEGORIES).optional(),
  params: reportParams.default({}),
  favorite: z.boolean().default(false),
  schedule: z.enum(SCHEDULES).default("off"),
  formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(3).default(["csv"]),
  recipients: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
});
export const reportBody = reportBase;
export const reportPatch = patchOf(reportBase);
export const scheduleBody = z.object({
  schedule: z.enum(SCHEDULES),
  recipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
  formats: z.array(z.enum(REPORT_FORMATS)).min(1).max(3).optional(),
});
export const runBody = z.object({ format: z.enum(REPORT_FORMATS).default("csv") });

export const reportListQuery = pageQuery.extend({
  category: z.enum(["all", ...REPORT_CATEGORIES]).default("all"),
  tab: z.enum(["library", "scheduled", "favorites"]).default("library"),
});
export const runListQuery = pageQuery.extend({
  reportId: z.string().max(64).optional(),
  status: z.enum(["queued", "running", "ready", "failed"]).optional(),
});
export const runIdParam = z.object({ runId: z.string().min(1).max(64) });

export type ReportBody = z.infer<typeof reportBody>;
export type ReportPatch = z.infer<typeof reportPatch>;
export type ScheduleBody = z.infer<typeof scheduleBody>;
export type RunBody = z.infer<typeof runBody>;
export type ReportListQuery = z.infer<typeof reportListQuery>;
export type RunListQuery = z.infer<typeof runListQuery>;
