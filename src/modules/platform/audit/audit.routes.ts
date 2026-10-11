import { z } from "zod";
import { ModuleRouter, withMeta } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { pageMeta, pageQuery, paging } from "@/core/http/pagination";
import { toCsv } from "@/core/utils/csv";

const filters = pageQuery.extend({
  category: z.string().optional(),
  severity: z.enum(["info", "notice", "warning", "critical"]).optional(),
  actor: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function where(q: z.infer<typeof filters>) {
  return {
    category: q.category,
    severity: q.severity,
    actorEmail: q.actor,
    createdAt: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    OR: q.q ? [{ summary: { contains: q.q } }, { actorName: { contains: q.q } }, { entityId: q.q }, { action: { contains: q.q } }] : undefined,
  };
}

/** asl-admin /audit */
export const auditAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/audit", tag: "Audit", defaultAuth: "admin", defaultPermission: "audit.view" })
  .get("/", { summary: "Audit log", query: filters }, async ({ query }) => {
    const w = where(query);
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({ where: w, orderBy: { createdAt: "desc" }, ...paging(query) }),
      prisma.auditEvent.count({ where: w }),
    ]);
    return withMeta(rows, pageMeta(query, total));
  })
  .get("/export", { summary: "Export audit log (CSV)", query: filters.omit({ page: true, pageSize: true }) }, async ({ query, res }) => {
    const rows = await prisma.auditEvent.findMany({ where: where(query as any), orderBy: { createdAt: "desc" }, take: 50_000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(toCsv(rows, ["createdAt", "actorName", "actorEmail", "actorRole", "action", "category", "severity", "entity", "entityId", "summary", "ip", "device"]));
  });
