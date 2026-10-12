import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { randomToken, sha256 } from "@/core/auth/tokens";
import { PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, type Permission } from "@/core/auth/permissions";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { env } from "@/config/env";
import { events } from "@/core/events/bus";
import type { AdminRole } from "@/generated/prisma/enums";
import { clearPermissionCache, effectivePermissions } from "./team.permissions";

const INVITE_DAYS = 7;
const COLORS = ["#0f0f0f", "#cc5000", "#2563eb", "#059669", "#7c3aed", "#db2777", "#0891b2", "#ca8a04"];

const dto = (m: Awaited<ReturnType<typeof prisma.adminUser.findFirstOrThrow>>) => ({
  id: m.id, name: m.name, email: m.email, role: m.role, roleLabel: ROLE_LABELS[m.role], status: m.status,
  twoFactor: m.twoFactorEnabled, lastActiveAt: m.lastActiveAt, createdAt: m.createdAt, avatarColor: m.avatarColor,
});

async function sendInvite(adminId: string, inviter: string) {
  const m = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
  const token = randomToken();
  await prisma.adminInvite.create({ data: { adminId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) } });
  await messaging.email(m.email, "admin.invite", {
    name: m.name, inviter, role: ROLE_LABELS[m.role], inviteUrl: `${env.APP_URL}/admin/invite?token=${token}`,
  });
  return token;
}

async function assertNotLastSuperAdmin(id: string) {
  const m = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
  if (m.role !== "super_admin") return;
  const others = await prisma.adminUser.count({ where: { role: "super_admin", status: "active", NOT: { id } } });
  if (!others) throw ApiError.badRequest("INVALID_STATE", "You can't remove or demote the last Super Admin.");
}

export const teamService = {
  async list() {
    const rows = await prisma.adminUser.findMany({ orderBy: [{ status: "asc" }, { name: "asc" }] });
    return rows.map(dto);
  },

  async invite(input: { name: string; email: string; role: AdminRole }, inviter: string) {
    const exists = await prisma.adminUser.findUnique({ where: { email: input.email } });
    if (exists) throw ApiError.conflict("EMAIL_TAKEN", "This email is already on the team.");
    const m = await prisma.adminUser.create({
      data: { ...input, status: "invited", avatarColor: COLORS[Math.floor(Math.random() * COLORS.length)] },
    });
    const token = await sendInvite(m.id, inviter);
    return { member: dto(m), inviteToken: env.NODE_ENV === "production" ? undefined : token };
  },

  async resendInvite(id: string, inviter: string) {
    const m = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    if (m.status !== "invited") throw ApiError.badRequest("INVALID_STATE", "This member has already joined.");
    await prisma.adminInvite.updateMany({ where: { adminId: id, acceptedAt: null }, data: { expiresAt: new Date() } });
    await sendInvite(id, inviter);
    return { resent: true };
  },

  async update(id: string, patch: { name?: string; role?: AdminRole; status?: "active" | "suspended" }, actorId: string, actorName?: string) {
    const before = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    if ((patch.role && patch.role !== "super_admin") || patch.status === "suspended") await assertNotLastSuperAdmin(id);
    if (id === actorId && patch.status === "suspended") throw ApiError.badRequest("INVALID_STATE", "You can't suspend yourself.");
    if (patch.status === "active" && before.status === "invited") throw ApiError.badRequest("INVALID_STATE", "Invited members activate by accepting their invite.");
    const m = await prisma.adminUser.update({ where: { id }, data: patch });
    if (patch.status === "suspended") await prisma.adminSession.updateMany({ where: { adminId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (patch.role && patch.role !== before.role)
      events.emit("team.access_changed", { kind: "role", adminId: id, role: m.role, from: before.role, to: m.role, by: actorName });
    if (patch.status && patch.status !== before.status)
      events.emit("team.access_changed", { kind: "status", adminId: id, role: m.role, from: before.status, to: m.status, by: actorName });
    return { before: dto(before), after: dto(m) };
  },

  async remove(id: string, actorId: string) {
    if (id === actorId) throw ApiError.badRequest("INVALID_STATE", "You can't remove yourself.");
    await assertNotLastSuperAdmin(id);
    const m = await prisma.adminUser.delete({ where: { id } });
    return dto(m);
  },

  async roles() {
    const counts = await prisma.adminUser.groupBy({ by: ["role"], _count: true });
    const overrides = await prisma.rolePermissionOverride.findMany();
    return (Object.keys(ROLE_PERMISSIONS) as AdminRole[]).map(async (role) => ({
      role,
      label: ROLE_LABELS[role],
      members: counts.find((c) => c.role === role)?._count ?? 0,
      permissions: [...(await effectivePermissions(role))],
      defaults: ROLE_PERMISSIONS[role],
      customized: overrides.some((o) => o.role === role),
    }));
  },

  async setRolePermissions(role: AdminRole, perms: Permission[], by?: string) {
    if (role === "super_admin") throw ApiError.badRequest("INVALID_STATE", "Super Admin always has every permission.");
    const clean = [...new Set(perms.filter((p) => (PERMISSIONS as readonly string[]).includes(p)))];
    await prisma.rolePermissionOverride.upsert({ where: { role }, create: { role, permissions: clean }, update: { permissions: clean } });
    clearPermissionCache();
    events.emit("team.access_changed", { kind: "permissions", role, to: "custom", by });
    return { role, permissions: clean };
  },

  async resetRolePermissions(role: AdminRole, by?: string) {
    const { count } = await prisma.rolePermissionOverride.deleteMany({ where: { role } });
    clearPermissionCache();
    if (count) events.emit("team.access_changed", { kind: "permissions", role, to: "defaults", by });
    return { role, permissions: ROLE_PERMISSIONS[role] };
  },
};
