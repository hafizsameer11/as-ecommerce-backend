import { withMeta, type Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { auditService as svc } from "./audit.service";
import type { AuditExportQuery, AuditFilters } from "./audit.schemas";

export const auditController = {
  list: async ({ query }: Ctx<unknown, AuditFilters>) => {
    const r = await svc.list(query);
    return withMeta(r.items, r.meta);
  },
  exportCsv: async ({ query, res }: Ctx<unknown, AuditExportQuery>) => sendCsv(res, "audit", await svc.exportCsv(query)),
};
