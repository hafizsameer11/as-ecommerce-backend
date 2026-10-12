/**
 * asl-admin /segments: saved customer audiences (rules over profile + CustomerStats + tags).
 * Other modules use `customerWhere(segmentId)` / `isMember(...)` (campaigns, push blasts, segment coupons).
 */
import type { Prisma, Segment } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { toCsv } from "@/core/utils/csv";
import { customerRowInclude, toAdminCustomerRow } from "@/modules/identity/customers/customers.mapper";
import { compileSegment } from "./segments.rules";
import type { RulesBody, SegmentBody, SegmentCustomersQuery, SegmentListQuery, SegmentPatch, SegmentRule } from "./segments.schemas";

const N = (naira: number) => naira * 100;

/** the admin's built-in presets (money in kobo); created on first use, can't be deleted */
const PRESETS: Omit<Segment, "createdAt" | "updatedAt">[] = [
  { id: "seg_vip", name: "VIP · Signature Club", description: "Signature-tier members with lifetime spend above ₦3.5M.", color: "#B8862B", match: "all",
    rules: [{ field: "tier", op: "in", value: ["Signature"] }, { field: "spend", op: "gte", value: N(3_500_000) }], pinned: true, system: true },
  { id: "seg_high_intent", name: "High-intent Concierge", description: "Placed 2+ concierge requests, ordered in the last 90 days.", color: "#0F5F4A", match: "all",
    rules: [{ field: "concierge", op: "gte", value: 2 }, { field: "lastOrderAt", op: "within_days", value: 90 }], pinned: true, system: true },
  { id: "seg_dormant", name: "Dormant · 120+ days", description: "Repeat customers who have not ordered in the last 120 days.", color: "#7C3AED", match: "all",
    rules: [{ field: "orders", op: "gte", value: 2 }, { field: "lastOrderAt", op: "before_days", value: 120 }], pinned: false, system: true },
  { id: "seg_marketing", name: "Marketing opt-in", description: "All active customers who accept marketing communications.", color: "#B54708", match: "all",
    rules: [{ field: "marketingOptIn", op: "eq", value: true }, { field: "status", op: "in", value: ["active", "vip"] }], pinned: false, system: true },
];

/** live customers only (deleted / anonymised accounts never match) */
const LIVE: Prisma.CustomerWhereInput = { deletedAt: null };

const rulesOf = (s: Pick<Segment, "rules">) => (s.rules as SegmentRule[]) ?? [];
const whereOf = (s: Pick<Segment, "match" | "rules">): Prisma.CustomerWhereInput => ({ AND: [LIVE, compileSegment({ match: s.match, rules: rulesOf(s) })] });

const toAdmin = (s: Segment, count?: number) => ({
  id: s.id, name: s.name, description: s.description ?? "", color: s.color, match: s.match as "all" | "any", rules: rulesOf(s),
  pinned: s.pinned, system: s.system, createdAt: s.createdAt, updatedAt: s.updatedAt,
  ...(count === undefined ? {} : { count }),
});

async function ensurePresets() {
  if (await prisma.segment.count({ where: { system: true } })) return;
  await prisma.segment.createMany({ data: PRESETS.map((p) => ({ ...p, rules: p.rules as Prisma.InputJsonValue })), skipDuplicates: true });
}

async function find(id: string) {
  const s = await prisma.segment.findUnique({ where: { id } });
  if (!s) throw ApiError.notFound("Segment");
  return s;
}

/** fail early on rules that can't compile (wrong op for a field, bad values) */
const check = (match: string, rules: SegmentRule[]) => void compileSegment({ match, rules });

async function stats(where: Prisma.CustomerWhereInput, sampleSize = 20) {
  const [count, marketable, total, spend, sample] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.count({ where: { AND: [where, { marketingOptIn: true, status: { not: "blocked" } }] } }),
    prisma.customer.count({ where: LIVE }),
    prisma.customerStats.aggregate({ where: { customer: where }, _sum: { totalSpend: true } }),
    prisma.customer.findMany({ where, include: customerRowInclude, orderBy: [{ stats: { totalSpend: "desc" } }, { id: "asc" }], take: sampleSize }),
  ]);
  const totalSpend = Number(spend._sum.totalSpend ?? 0);
  return {
    count, marketable, share: total ? count / total : 0, spend: totalSpend, aov: count ? Math.round(totalSpend / count) : 0,
    sample: sample.map((c) => toAdminCustomerRow(c)),
  };
}

export const segmentsService = {
  /** Prisma `where` for the segment's (live) customers. Throws 404 for an unknown segment. */
  async customerWhere(segmentId: string): Promise<Prisma.CustomerWhereInput> {
    return whereOf(await find(segmentId));
  },

  async isMember(segmentId: string, customerId: string) {
    const s = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (!s) return false;
    return (await prisma.customer.count({ where: { AND: [{ id: customerId }, whereOf(s)] } })) > 0;
  },

  async list(q: SegmentListQuery) {
    await ensurePresets();
    const where: Prisma.SegmentWhereInput = {
      ...(q.pinned ? { pinned: q.pinned === "true" } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q } }, { description: { contains: q.q } }] } : {}),
    };
    const [rows, total, pinned, system] = await Promise.all([
      prisma.segment.findMany({ where, orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }], ...paging(q) }),
      prisma.segment.count({ where }),
      prisma.segment.count({ where: { pinned: true } }),
      prisma.segment.count({ where: { system: true } }),
    ]);
    const counts = q.counts === "true" ? await Promise.all(rows.map((s) => prisma.customer.count({ where: whereOf(s) }).catch(() => 0))) : [];
    const customers = await prisma.customer.count({ where: LIVE });
    return withMeta(rows.map((s, i) => toAdmin(s, counts[i])), { ...pageMeta(q, total), kpis: { segments: total, pinned, system, customers } });
  },

  async get(id: string) {
    const s = await find(id);
    return toAdmin(s, await prisma.customer.count({ where: whereOf(s) }));
  },

  async create(b: SegmentBody) {
    check(b.match, b.rules);
    const s = await prisma.segment.create({ data: { ...b, description: b.description ?? null, rules: b.rules as Prisma.InputJsonValue, system: false } });
    return toAdmin(s);
  },

  async update(id: string, patch: SegmentPatch) {
    const before = toAdmin(await find(id));
    check(patch.match ?? before.match, patch.rules ?? before.rules);
    const s = await prisma.segment.update({ where: { id }, data: { ...patch, rules: patch.rules as Prisma.InputJsonValue | undefined } });
    return { before, after: toAdmin(s) };
  },

  async duplicate(id: string) {
    const s = await find(id);
    const copy = await prisma.segment.create({
      data: { name: `${s.name} (copy)`, description: s.description, color: s.color, match: s.match, rules: s.rules as Prisma.InputJsonValue, pinned: false, system: false },
    });
    return toAdmin(copy);
  },

  async togglePin(id: string) {
    const s = await find(id);
    return toAdmin(await prisma.segment.update({ where: { id }, data: { pinned: !s.pinned } }));
  },

  async remove(id: string) {
    const s = await find(id);
    if (s.system) throw ApiError.badRequest("INVALID_STATE", "Built-in segments can't be deleted. Duplicate it to make your own version.");
    const [campaigns, coupons] = await Promise.all([
      prisma.campaign.count({ where: { segmentId: id, status: { in: ["scheduled", "sending"] } } }),
      prisma.coupon.count({ where: { segmentId: id, eligibility: "segment", status: { in: ["active", "scheduled"] } } }),
    ]);
    if (campaigns || coupons)
      throw ApiError.conflict("CONFLICT", "This segment is used by a scheduled campaign or an active coupon.", { campaigns, coupons });
    await prisma.segment.delete({ where: { id } });
    return { deleted: true, name: s.name };
  },

  /** count + top-20 sample for a saved segment */
  async preview(id: string) {
    return stats(whereOf(await find(id)));
  },

  /** live preview while editing rules (not saved) */
  async previewRules(b: RulesBody) {
    check(b.match, b.rules);
    return stats({ AND: [LIVE, compileSegment(b)] });
  },

  async customers(id: string, q: SegmentCustomersQuery) {
    const where = await this.customersWhere(id, q);
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({ where, include: customerRowInclude, orderBy: [{ stats: { totalSpend: "desc" } }, { id: "asc" }], ...paging(q) }),
      prisma.customer.count({ where }),
    ]);
    return withMeta(rows.map((c) => toAdminCustomerRow(c)), pageMeta(q, total));
  },

  async customersWhere(id: string, q: Pick<SegmentCustomersQuery, "q" | "marketable">): Promise<Prisma.CustomerWhereInput> {
    const base = await this.customerWhere(id);
    const words = (q.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
    return {
      AND: [
        base,
        q.marketable === "true" ? { marketingOptIn: true, status: { not: "blocked" } } : {},
        ...words.map((w) => ({ OR: [{ firstName: { contains: w } }, { lastName: { contains: w } }, { email: { contains: w } }] })),
      ],
    };
  },

  async exportCsv(id: string, q: Pick<SegmentCustomersQuery, "q" | "marketable">) {
    const s = await find(id);
    const rows = await prisma.customer.findMany({ where: await this.customersWhere(id, q), include: customerRowInclude, orderBy: { createdAt: "asc" }, take: 50_000 });
    const data = rows.map((c) => {
      const r = toAdminCustomerRow(c);
      return { ...r, tags: r.tags.join("; "), spend: r.spend / 100, aov: r.aov / 100 };
    });
    const csv = toCsv(
      data,
      ["id", "name", "email", "phone", "city", "country", "tier", "status", "orders", "concierge", "spend", "aov", "lastOrderAt", "createdAt", "marketingOptIn", "tags"],
      ["ID", "Name", "Email", "Phone", "City", "Country", "Tier", "Status", "Orders", "Concierge", "Spend (NGN)", "AOV (NGN)", "Last order", "Joined", "Marketing opt-in", "Tags"],
    );
    return { csv, name: `segment-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || s.id}` };
  },
};
