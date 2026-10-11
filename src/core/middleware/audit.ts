import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/core/db/prisma";
import { jsonReplacer } from "@/core/http/response";
import { logger } from "@/core/utils/logger";

/** snapshot for a Json column (BigInt → number, Date → ISO) */
const plain = (v: unknown) => (v == null ? undefined : JSON.parse(JSON.stringify(v, jsonReplacer)));

export type AuditSpec = {
  category: string;
  action: string;
  entity: string;
  severity?: "info" | "notice" | "warning" | "critical";
};

/** Services can enrich the audit record: res.locals.audit = { entityId, summary, before, after } */
export type AuditDetail = { entityId?: string; summary?: string; before?: unknown; after?: unknown };

export function audit(spec: AuditSpec) {
  return (req: Request, res: Response, next: NextFunction) => {
    // write the audit row BEFORE the response is sent, so "do X → read /audit" is consistent
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 400 || !req.admin) return json(body);
      const d = (res.locals.audit ?? {}) as AuditDetail;
      prisma.auditEvent
        .create({
          data: {
            actorId: req.admin.id,
            actorName: req.admin.name,
            actorEmail: req.admin.email,
            actorRole: req.admin.role,
            action: spec.action,
            category: spec.category,
            severity: spec.severity ?? "info",
            entity: spec.entity,
            entityId: d.entityId ?? (req.params?.id as string | undefined),
            summary: (d.summary ?? `${spec.action} ${spec.entity}`).slice(0, 500),
            ip: req.ip,
            device: req.headers["user-agent"]?.slice(0, 500),
            before: plain(d.before),
            after: plain(d.after),
          },
        })
        .catch((err) => logger.error({ err }, "audit write failed"))
        .finally(() => json(body));
      return res;
    }) as typeof res.json;
    next();
  };
}

/** For auth events (login/logout) that happen before req.admin exists. */
export async function auditDirect(data: {
  actorId?: string; actorName: string; actorEmail: string; actorRole: string; action: string; category: string;
  severity?: "info" | "notice" | "warning" | "critical"; entity: string; entityId?: string; summary: string; ip?: string; device?: string;
}) {
  await prisma.auditEvent.create({ data: { ...data, severity: data.severity ?? "info" } }).catch(() => undefined);
}
