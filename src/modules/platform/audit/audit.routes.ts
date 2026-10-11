import { ModuleRouter } from "@/core/http/router";
import { auditController as c } from "./audit.controller";
import { auditExportQuery, auditFilters } from "./audit.schemas";

/** asl-admin /audit */
export const auditAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/audit", tag: "Audit", defaultAuth: "admin", defaultPermission: "audit.view" })
  .get("/", { summary: "Audit log", query: auditFilters }, c.list)
  .get("/export", { summary: "Export audit log (CSV)", query: auditExportQuery }, c.exportCsv);
