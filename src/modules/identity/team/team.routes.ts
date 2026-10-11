import { z } from "zod";
import { ModuleRouter, idParam } from "@/core/http/router";
import { PERMISSIONS } from "@/core/auth/permissions";
import { teamService as svc } from "./team.service";

const role = z.enum(["super_admin", "ops_manager", "catalog_manager", "concierge_agent", "support", "marketing", "finance", "content_editor", "analyst"]);

/** asl-admin /team */
export const teamAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/team", tag: "Team", defaultAuth: "admin", defaultPermission: "team.manage" })
  .get("/members", { summary: "Team members" }, () => svc.list())
  .post("/members", {
    summary: "Invite a team member",
    body: z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email(), role }),
    status: 201,
    audit: { category: "team", action: "team.invited", entity: "admin", severity: "notice" },
  }, async ({ body, admin, res }) => {
    const r = await svc.invite(body, admin.name);
    res.locals.audit = { entityId: r.member.id, summary: `Invited ${body.email} as ${body.role}` };
    return r;
  })
  .patch("/members/:id", {
    summary: "Change role, suspend / reactivate, rename",
    params: idParam,
    body: z.object({ name: z.string().min(1).max(80).optional(), role: role.optional(), status: z.enum(["active", "suspended"]).optional() }),
    audit: { category: "team", action: "team.updated", entity: "admin", severity: "notice" },
  }, async ({ params, body, admin, res }) => {
    const r = await svc.update(params.id, body, admin.id);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated ${r.after.email}` };
    return r.after;
  })
  .delete("/members/:id", { summary: "Remove member", params: idParam, audit: { category: "team", action: "team.removed", entity: "admin", severity: "warning" } },
    async ({ params, admin, res }) => {
      const m = await svc.remove(params.id, admin.id);
      res.locals.audit = { entityId: params.id, before: m, summary: `Removed ${m.email}` };
      return { removed: true };
    })
  .post("/members/:id/resend-invite", { summary: "Resend invite", params: idParam, audit: { category: "team", action: "team.invite_resent", entity: "admin" } },
    ({ params, admin }) => svc.resendInvite(params.id, admin.name))
  .get("/roles", { summary: "Roles with effective permissions" }, async () => Promise.all(await svc.roles()))
  .get("/permissions", { summary: "All permission keys" }, () => PERMISSIONS)
  .put("/roles/:role/permissions", {
    summary: "Override a role's permissions",
    params: z.object({ role }),
    body: z.object({ permissions: z.array(z.enum(PERMISSIONS)) }),
    audit: { category: "team", action: "role.permissions_changed", entity: "role", severity: "warning" },
  }, ({ params, body }) => svc.setRolePermissions(params.role, body.permissions))
  .delete("/roles/:role/permissions", {
    summary: "Reset a role to its default permissions",
    params: z.object({ role }),
    audit: { category: "team", action: "role.permissions_reset", entity: "role", severity: "notice" },
  }, ({ params }) => svc.resetRolePermissions(params.role));
