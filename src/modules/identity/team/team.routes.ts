import { ModuleRouter, idParam } from "@/core/http/router";
import { teamController as c } from "./team.controller";
import { inviteBody, memberPatch, roleParam, rolePermissionsBody } from "./team.schemas";

/** asl-admin /team */
export const teamAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/team", tag: "Team", defaultAuth: "admin", defaultPermission: "team.manage" })
  .get("/members", { summary: "Team members" }, c.list)
  .post("/members", {
    summary: "Invite a team member",
    body: inviteBody,
    status: 201,
    audit: { category: "team", action: "team.invited", entity: "admin", severity: "notice" },
  }, c.invite)
  .patch("/members/:id", {
    summary: "Change role, suspend / reactivate, rename",
    params: idParam,
    body: memberPatch,
    audit: { category: "team", action: "team.updated", entity: "admin", severity: "notice" },
  }, c.update)
  .delete("/members/:id", { summary: "Remove member", params: idParam, audit: { category: "team", action: "team.removed", entity: "admin", severity: "warning" } }, c.remove)
  .post("/members/:id/resend-invite", { summary: "Resend invite", params: idParam, audit: { category: "team", action: "team.invite_resent", entity: "admin" } }, c.resendInvite)
  .get("/roles", { summary: "Roles with effective permissions" }, c.roles)
  .get("/permissions", { summary: "All permission keys" }, c.permissions)
  .put("/roles/:role/permissions", {
    summary: "Override a role's permissions",
    params: roleParam,
    body: rolePermissionsBody,
    audit: { category: "team", action: "role.permissions_changed", entity: "role", severity: "warning" },
  }, c.setRolePermissions)
  .delete("/roles/:role/permissions", {
    summary: "Reset a role to its default permissions",
    params: roleParam,
    audit: { category: "team", action: "role.permissions_reset", entity: "role", severity: "notice" },
  }, c.resetRolePermissions);
