import { prisma } from "@/core/db/prisma";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/core/auth/permissions";
import type { AdminRole } from "@/generated/prisma/enums";

const cache = new Map<AdminRole, { at: number; perms: Set<Permission> }>();

/** role defaults, unless an admin has overridden the role's permission set */
export async function effectivePermissions(role: AdminRole): Promise<Set<Permission>> {
  const c = cache.get(role);
  if (c && Date.now() - c.at < 15_000) return c.perms;
  const o = await prisma.rolePermissionOverride.findUnique({ where: { role } });
  const list = (o?.permissions as Permission[] | undefined) ?? ROLE_PERMISSIONS[role];
  // super_admin always keeps everything (prevents locking everyone out)
  const perms = new Set<Permission>(role === "super_admin" ? PERMISSIONS : list.filter((p) => PERMISSIONS.includes(p)));
  cache.set(role, { at: Date.now(), perms });
  return perms;
}

export const clearPermissionCache = () => cache.clear();
