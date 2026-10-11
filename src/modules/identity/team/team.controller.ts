import type { Ctx } from "@/core/http/router";
import { PERMISSIONS } from "@/core/auth/permissions";
import { teamService as svc } from "./team.service";
import type { InviteBody, MemberPatch, RoleParam, RolePermissionsBody } from "./team.schemas";

type Id = { id: string };

export const teamController = {
  list: () => svc.list(),
  invite: async ({ body, admin, res }: Ctx<InviteBody>) => {
    const r = await svc.invite(body, admin.name);
    res.locals.audit = { entityId: r.member.id, summary: `Invited ${body.email} as ${body.role}` };
    return r;
  },
  update: async ({ params, body, admin, res }: Ctx<MemberPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body, admin.id);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated ${r.after.email}` };
    return r.after;
  },
  remove: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const m = await svc.remove(params.id, admin.id);
    res.locals.audit = { entityId: params.id, before: m, summary: `Removed ${m.email}` };
    return { removed: true };
  },
  resendInvite: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.resendInvite(params.id, admin.name),
  roles: async () => Promise.all(await svc.roles()),
  permissions: () => PERMISSIONS,
  setRolePermissions: ({ params, body }: Ctx<RolePermissionsBody, unknown, RoleParam>) => svc.setRolePermissions(params.role, body.permissions),
  resetRolePermissions: ({ params }: Ctx<unknown, unknown, RoleParam>) => svc.resetRolePermissions(params.role),
};
