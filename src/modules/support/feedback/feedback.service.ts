import type { Feedback, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { customerBrief, fullName } from "@/modules/identity/auth/customer.mapper";
import { FEEDBACK_STATUSES, FEEDBACK_TYPES, type AdminFeedbackQuery, type FeedbackBody } from "./feedback.schemas";

type Row = Feedback & { customer: { id: string; firstName: string; lastName: string; email: string } | null };

const toAdmin = (f: Row) => ({
  id: f.id, type: f.type, area: f.area, message: f.message, replyEmail: f.replyEmail, status: f.status, createdAt: f.createdAt,
  customer: f.customer ? { id: f.customer.id, name: fullName(f.customer), email: f.customer.email } : null,
});

export const feedbackService = {
  /** /account/feedback */
  async create(customerId: string, b: FeedbackBody) {
    const f = await prisma.feedback.create({ data: { customerId, type: b.type, area: b.area, message: b.message, replyEmail: b.email || null } });
    return { id: f.id, type: f.type, area: f.area, status: f.status, createdAt: f.createdAt, message: "Thanks — your feedback reached the team." };
  },

  // ── admin ──
  async adminList(q: AdminFeedbackQuery) {
    const base: Prisma.FeedbackWhereInput = {
      type: q.type,
      area: q.area,
      OR: q.q ? [{ message: { contains: q.q } }, { replyEmail: { contains: q.q } }, { customer: { email: { contains: q.q } } }] : undefined,
    };
    const where: Prisma.FeedbackWhereInput = { ...base, status: q.status };
    const [rows, total, byStatus, byType] = await Promise.all([
      prisma.feedback.findMany({ where, include: { customer: { select: customerBrief } }, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.feedback.count({ where }),
      prisma.feedback.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
      prisma.feedback.groupBy({ by: ["type"], where: base, _count: { _all: true } }),
    ]);
    const tabs = { all: byStatus.reduce((n, g) => n + g._count._all, 0), ...Object.fromEntries(FEEDBACK_STATUSES.map((s) => [s, byStatus.find((g) => g.status === s)?._count._all ?? 0])) };
    const kpis = Object.fromEntries(FEEDBACK_TYPES.map((t) => [t, byType.find((g) => g.type === t)?._count._all ?? 0]));
    return withMeta(rows.map(toAdmin), { ...pageMeta(q, total), tabs, kpis });
  },

  async setStatus(id: string, status: (typeof FEEDBACK_STATUSES)[number]) {
    const f = await prisma.feedback.findUnique({ where: { id } });
    if (!f) throw ApiError.notFound("Feedback");
    const updated = await prisma.feedback.update({ where: { id }, data: { status }, include: { customer: { select: customerBrief } } });
    return { before: { status: f.status }, after: toAdmin(updated) };
  },
};
