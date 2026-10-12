import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";
import { patchOf } from "@/core/http/patch-schema";

const accountType = z.enum(["asset", "liability", "equity", "revenue", "expense"]);
const source = z.enum(["order", "refund", "payout", "fee", "adjustment", "tax", "wallet", "manual"]);
/** kobo */
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const accountCodeParam = z.object({ code: z.string().regex(/^\d{3,6}$/, "Account codes are 3–6 digits") });
export const accountsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includeArchived: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});
export const accountBody = z.object({
  code: z.string().regex(/^\d{3,6}$/, "Account codes are 3–6 digits"),
  name: z.string().trim().min(2).max(120),
  type: accountType,
});
export const accountPatch = z.object({ name: z.string().trim().min(2).max(120) });

export const lineInput = z.object({
  accountCode: z.string().min(1).max(10),
  debit: money.default(0),
  credit: money.default(0),
  memo: z.string().trim().max(300).nullable().optional(),
});
export const entryBody = z.object({
  date: z.coerce.date().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().min(2).max(300),
  /** manual entries are "manual" unless finance books an adjustment / tax remittance */
  source: z.enum(["manual", "adjustment", "tax"]).default("manual"),
  status: z.enum(["draft", "posted"]).default("posted"),
  lines: z.array(lineInput).min(2).max(100),
});
export const entryPatch = patchOf(entryBody.omit({ status: true }));

export const entriesQuery = pageQuery.extend({
  source: source.optional(),
  status: z.enum(["draft", "posted", "void"]).optional(),
  account: z.string().max(10).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const periodQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

export type AccountsQuery = z.infer<typeof accountsQuery>;
export type AccountBody = z.infer<typeof accountBody>;
export type AccountPatch = z.infer<typeof accountPatch>;
export type LineInput = z.input<typeof lineInput>;
export type EntryBody = z.infer<typeof entryBody>;
export type EntryPatch = z.infer<typeof entryPatch>;
export type EntriesQuery = z.infer<typeof entriesQuery>;
export type PeriodQuery = z.infer<typeof periodQuery>;
