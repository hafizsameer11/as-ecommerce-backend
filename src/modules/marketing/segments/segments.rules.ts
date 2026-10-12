/**
 * Segment rules → Prisma `where` on Customer (joined with CustomerStats + CustomerTag).
 * Money rules (spend, aov) are kobo. Country accepts ISO codes ("NG") or names ("Nigeria").
 */
import type { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/core/http/errors";
import type { SegmentRule } from "./segments.schemas";

export const RULE_FIELDS = [
  "spend", "orders", "aov", "concierge", "tier", "status", "country", "city", "tags", "marketingOptIn", "lastOrderAt", "createdAt",
] as const;
export const RULE_OPS = ["eq", "neq", "gt", "lt", "gte", "lte", "in", "contains", "within_days", "before_days"] as const;

type Field = (typeof RULE_FIELDS)[number];
type Op = (typeof RULE_OPS)[number];

const NUMERIC: Partial<Record<Field, "totalSpend" | "ordersCount" | "aov" | "conciergeCount">> = {
  spend: "totalSpend", orders: "ordersCount", aov: "aov", concierge: "conciergeCount",
};
const TIERS = ["Standard", "Silver", "Gold", "Signature"] as const;
const STATUSES = ["active", "vip", "flagged", "blocked"] as const;
const DAY = 86_400_000;

const bad = (r: SegmentRule, why: string) =>
  ApiError.badRequest("VALIDATION_FAILED", `Rule "${r.field} ${r.op}": ${why}`, { field: r.field, op: r.op });

const list = (r: SegmentRule): unknown[] => (Array.isArray(r.value) ? r.value : [r.value]);
const num = (r: SegmentRule) => {
  const v = typeof r.value === "string" ? Number(r.value) : r.value;
  if (typeof v !== "number" || !Number.isFinite(v)) throw bad(r, "needs a number");
  return v;
};
const strs = (r: SegmentRule) => {
  const v = list(r).map((x) => String(x).trim()).filter(Boolean);
  if (!v.length) throw bad(r, "needs at least one value");
  return v;
};

// country names → ISO-3166 alpha-2 (built once from Intl)
let countryCodes: Map<string, string> | null = null;
function countryCode(v: string) {
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase() === "UK" ? "GB" : v.toUpperCase();
  if (!countryCodes) {
    countryCodes = new Map();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        try {
          const n = names.of(code);
          // first (alphabetical) code wins, except deprecated aliases like UK → GB handled below
          if (n && n !== code && !countryCodes.has(n.toLowerCase())) countryCodes.set(n.toLowerCase(), code);
        } catch {
          /* not a region */
        }
      }
    countryCodes.set("united kingdom", "GB").set("uk", "GB").set("uae", "AE").set("usa", "US");
  }
  return countryCodes.get(v.toLowerCase()) ?? v.toUpperCase();
}

function enumIn<T extends string>(r: SegmentRule, allowed: readonly T[], col: "tier" | "status"): Prisma.CustomerWhereInput {
  const vals = strs(r) as T[];
  const unknown = vals.filter((v) => !allowed.includes(v));
  if (unknown.length) throw bad(r, `unknown value ${unknown.join(", ")}`);
  if (r.op === "neq") return { [col]: { notIn: vals } };
  if (r.op === "in" || r.op === "eq") return { [col]: { in: vals } };
  throw bad(r, "use in, eq or neq");
}

/** stats-based number rule; customers without a stats row count as 0 */
function numeric(r: SegmentRule, col: "totalSpend" | "ordersCount" | "aov" | "conciergeCount"): Prisma.CustomerWhereInput {
  const v = num(r);
  const cmp: Record<string, [object, boolean]> = {
    eq: [{ equals: v }, v === 0], neq: [{ not: v }, v !== 0],
    gt: [{ gt: v }, 0 > v], gte: [{ gte: v }, 0 >= v], lt: [{ lt: v }, 0 < v], lte: [{ lte: v }, 0 <= v],
  };
  const c = cmp[r.op];
  if (!c) throw bad(r, "use eq, neq, gt, gte, lt or lte");
  const where: Prisma.CustomerWhereInput = { stats: { is: { [col]: c[0] } } };
  return c[1] ? { OR: [where, { stats: { is: null } }] } : where;
}

function dateRule(r: SegmentRule, col: "lastOrderAt" | "createdAt", now: Date): Prisma.CustomerWhereInput {
  const days = num(r);
  const cutoff = new Date(now.getTime() - days * DAY);
  let cond: Prisma.DateTimeFilter;
  if (r.op === "within_days") cond = { gte: cutoff };
  else if (r.op === "before_days") cond = { lt: cutoff };
  else throw bad(r, "use within_days or before_days");
  return col === "createdAt" ? { createdAt: cond } : { stats: { is: { lastOrderAt: cond } } };
}

export function compileRule(r: SegmentRule, now = new Date()): Prisma.CustomerWhereInput {
  const statsCol = NUMERIC[r.field];
  if (statsCol) return numeric(r, statsCol);
  switch (r.field as Field) {
    case "tier":
      return enumIn(r, TIERS, "tier");
    case "status":
      return enumIn(r, STATUSES, "status");
    case "country": {
      const codes = strs(r).map(countryCode);
      if (r.op === "neq") return { OR: [{ country: { notIn: codes } }, { country: null }] };
      if (r.op === "in" || r.op === "eq") return { country: { in: codes } };
      throw bad(r, "use in, eq or neq");
    }
    case "city": {
      const v = strs(r);
      if (r.op === "contains") return { OR: v.map((x) => ({ city: { contains: x } })) };
      if (r.op === "eq" || r.op === "in") return { city: { in: v } };
      if (r.op === "neq") return { OR: [{ city: { notIn: v } }, { city: null }] };
      throw bad(r, "use contains, eq, in or neq");
    }
    case "tags": {
      const v = strs(r).map((t) => t.toLowerCase());
      if (r.op === "in" || r.op === "eq" || r.op === "contains") return { tags: { some: { tag: { in: v } } } };
      if (r.op === "neq") return { tags: { none: { tag: { in: v } } } };
      throw bad(r, "use in, contains or neq");
    }
    case "marketingOptIn": {
      const v = r.value === true || r.value === "true" ? true : r.value === false || r.value === "false" ? false : null;
      if (v === null) throw bad(r, "needs true or false");
      if (r.op === "eq") return { marketingOptIn: v };
      if (r.op === "neq") return { marketingOptIn: !v };
      throw bad(r, "use eq or neq");
    }
    case "lastOrderAt":
      return dateRule(r, "lastOrderAt", now);
    case "createdAt":
      return dateRule(r, "createdAt", now);
  }
  throw bad(r, "unknown field");
}

/** a segment with no rules matches nobody (same as the admin preview) */
export function compileSegment(seg: { match: string; rules: SegmentRule[] }, now = new Date()): Prisma.CustomerWhereInput {
  if (!seg.rules.length) return { id: { in: [] } };
  const parts = seg.rules.map((r) => compileRule(r, now));
  return seg.match === "any" ? { OR: parts } : { AND: parts };
}

export type { Field as RuleField, Op as RuleOp };
