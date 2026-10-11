import { prisma } from "@/core/db/prisma";
import { pageMeta, paging } from "@/core/http/pagination";
import { toCsv } from "@/core/utils/csv";
import type { AuditExportQuery, AuditFilters } from "./audit.schemas";

function where(q: AuditExportQuery) {
  return {
    category: q.category,
    severity: q.severity,
    actorEmail: q.actor,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    OR: q.q ? [{ summary: { contains: q.q } }, { actorName: { contains: q.q } }, { entityId: q.q }, { action: { contains: q.q } }] : undefined,
  };
}

export const auditService = {
  async list(query: AuditFilters) {
    const w = where(query);
    const [items, total] = await Promise.all([
      prisma.auditEvent.findMany({ where: w, orderBy: { createdAt: "desc" }, ...paging(query) }),
      prisma.auditEvent.count({ where: w }),
    ]);
    return { items, meta: pageMeta(query, total) };
  },

  async exportCsv(query: AuditExportQuery) {
    const rows = await prisma.auditEvent.findMany({ where: where(query), orderBy: { createdAt: "desc" }, take: 50_000 });
    return toCsv(rows, ["createdAt", "actorName", "actorEmail", "actorRole", "action", "category", "severity", "entity", "entityId", "summary", "ip", "device"]);
  },
};
