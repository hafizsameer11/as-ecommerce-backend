import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const auditFilters = pageQuery.extend({
  category: z.string().optional(),
  severity: z.enum(["info", "notice", "warning", "critical"]).optional(),
  actor: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const auditExportQuery = auditFilters.omit({ page: true, pageSize: true });

export type AuditFilters = z.infer<typeof auditFilters>;
export type AuditExportQuery = z.infer<typeof auditExportQuery>;
