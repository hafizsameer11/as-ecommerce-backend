import jwt from "jsonwebtoken";
import type { Response } from "express";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { randomToken, refreshExpiry, sha256, signAccessToken } from "@/core/auth/tokens";
import { newTotpSecret, totpUri, verifyTotp } from "@/core/auth/totp";
import { ADMIN_COOKIE } from "@/core/middleware/auth";
import { auditDirect } from "@/core/middleware/audit";
import { env, isProd } from "@/config/env";
import { ROLE_LABELS } from "@/core/auth/permissions";
import { effectivePermissions } from "../team/team.permissions";
import type { SessionMeta } from "../auth/session.service";

export const ADMIN_REFRESH_COOKIE = "asl_admin_rt";

async function issue(adminId: string, role: string, meta: SessionMeta, family = randomToken(12)) {
  const refreshToken = randomToken();
  const s = await prisma.adminSession.create({
    data: { adminId, refreshTokenHash: sha256(refreshToken), family, userAgent: meta.userAgent, ip: meta.ip, expiresAt: refreshExpiry() },
  });
  return { accessToken: signAccessToken({ sub: adminId, sid: s.id, aud: "admin", role }), refreshToken, sessionId: s.id, expiresIn: env.JWT_ACCESS_TTL };
}

export async function adminProfile(id: string) {
  const a = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
  return {
    id: a.id, name: a.name, email: a.email, role: a.role, roleLabel: ROLE_LABELS[a.role], status: a.status,
    avatarColor: a.avatarColor, twoFactorEnabled: a.twoFactorEnabled, density: a.density, sidebarCollapsed: a.sidebarCollapsed,
    permissions: [...(await effectivePermissions(a.role))],
  };
}

export function setAdminCookies(res: Response, t: { accessToken: string; refreshToken: string }) {
  // sameSite none + secure so admin frontends on other origins can use cookie auth
  const base = { httpOnly: true, secure: isProd, sameSite: (isProd ? "none" : "lax") as "none" | "lax" };
  res.cookie(ADMIN_COOKIE, t.accessToken, { ...base, maxAge: 15 * 60_000, path: "/" });
  res.cookie(ADMIN_REFRESH_COOKIE, t.refreshToken, { ...base, maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000, path: "/api/v1/admin/auth" });
}

export function clearAdminCookies(res: Response) {
  res.clearCookie(ADMIN_COOKIE, { path: "/" });
  res.clearCookie(ADMIN_REFRESH_COOKIE, { path: "/api/v1/admin/auth" });
}

export const adminAuthService = {
  async login(email: string, password: string, meta: SessionMeta) {
    const a = await prisma.adminUser.findUnique({ where: { email } });
    if (!a || !a.passwordHash || !(await verifyPassword(a.passwordHash, password))) {
      await auditDirect({ actorName: email, actorEmail: email, actorRole: "-", action: "auth.login_failed", category: "auth", severity: "warning", entity: "admin", summary: `Failed sign-in for ${email}`, ip: meta.ip, device: meta.userAgent });
      throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    }
    if (a.status !== "active") throw new ApiError(403, "ACCOUNT_BLOCKED", "This team account is suspended.");
    if (a.twoFactorEnabled) {
      const challenge = jwt.sign({ purpose: "2fa" }, env.JWT_ACCESS_SECRET, { subject: a.id, audience: "admin-2fa", expiresIn: "5m" });
      return { twoFactorRequired: true as const, challenge };
    }
    return this.finish(a.id, meta);
  },

  async loginTwoFactor(challenge: string, code: string, meta: SessionMeta) {
    let id: string;
    try {
      id = String((jwt.verify(challenge, env.JWT_ACCESS_SECRET, { audience: "admin-2fa" }) as jwt.JwtPayload).sub);
    } catch {
      throw new ApiError(401, "TOKEN_INVALID", "This sign-in attempt expired. Please sign in again.");
    }
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    if (!a.twoFactorSecret || !verifyTotp(a.twoFactorSecret, code)) throw new ApiError(401, "TWO_FACTOR_INVALID", "That code didn't work.");
    return this.finish(id, meta);
  },

  async finish(id: string, meta: SessionMeta) {
    const a = await prisma.adminUser.update({ where: { id }, data: { lastActiveAt: new Date() } });
    const tokens = await issue(a.id, a.role, meta);
    await auditDirect({ actorId: a.id, actorName: a.name, actorEmail: a.email, actorRole: a.role, action: "auth.login", category: "auth", entity: "admin", entityId: a.id, summary: `${a.name} signed in`, ip: meta.ip, device: meta.userAgent });
    return { ...tokens, admin: await adminProfile(a.id) };
  },

  async refresh(refreshToken: string, meta: SessionMeta) {
    const hash = sha256(refreshToken);
    const s = await prisma.adminSession.findUnique({ where: { refreshTokenHash: hash }, include: { admin: true } });
    if (!s || s.revokedAt || s.expiresAt < new Date() || s.admin.status !== "active") {
      if (s?.revokedAt) await prisma.adminSession.updateMany({ where: { family: s.family }, data: { revokedAt: new Date() } });
      throw new ApiError(401, "TOKEN_INVALID", "Your session has expired. Please sign in again.");
    }
    const next = randomToken();
    await prisma.adminSession.update({ where: { id: s.id }, data: { refreshTokenHash: sha256(next), lastUsedAt: new Date(), ip: meta.ip ?? s.ip } });
    await prisma.adminSession.create({ data: { adminId: s.adminId, refreshTokenHash: hash, family: s.family, expiresAt: s.expiresAt, revokedAt: new Date() } });
    return { accessToken: signAccessToken({ sub: s.adminId, sid: s.id, aud: "admin", role: s.admin.role }), refreshToken: next, sessionId: s.id, expiresIn: env.JWT_ACCESS_TTL };
  },

  async logout(sessionId: string) {
    await prisma.adminSession.updateMany({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  },

  async acceptInvite(token: string, password: string, meta: SessionMeta) {
    const inv = await prisma.adminInvite.findUnique({ where: { tokenHash: sha256(token) } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw ApiError.badRequest("TOKEN_INVALID", "This invite link has expired. Ask for a new invite.");
    await prisma.$transaction([
      prisma.adminUser.update({ where: { id: inv.adminId }, data: { passwordHash: await hashPassword(password), status: "active" } }),
      prisma.adminInvite.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    return this.finish(inv.adminId, meta);
  },

  async updatePreferences(id: string, data: { density?: "comfortable" | "cozy" | "compact"; sidebarCollapsed?: boolean; name?: string }) {
    await prisma.adminUser.update({ where: { id }, data });
    return adminProfile(id);
  },

  async changePassword(id: string, current: string, next: string) {
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    if (!a.passwordHash || !(await verifyPassword(a.passwordHash, current))) throw ApiError.badRequest("INVALID_CREDENTIALS", "Your current password is incorrect.");
    await prisma.adminUser.update({ where: { id }, data: { passwordHash: await hashPassword(next) } });
    return { updated: true };
  },

  async setupTwoFactor(id: string) {
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    const secret = newTotpSecret();
    await prisma.adminUser.update({ where: { id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
    return { secret, otpauthUrl: totpUri(secret, `admin:${a.email}`) };
  },

  async enableTwoFactor(id: string, code: string) {
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { id } });
    if (!a.twoFactorSecret || !verifyTotp(a.twoFactorSecret, code)) throw ApiError.badRequest("TWO_FACTOR_INVALID", "That code didn't work.");
    await prisma.adminUser.update({ where: { id }, data: { twoFactorEnabled: true } });
    return { enabled: true };
  },

  /** Upsert seed super-admin (used by boot flag + bootstrap endpoint). */
  async ensureSeedAdmin(email = env.SEED_ADMIN_EMAIL, password = env.SEED_ADMIN_PASSWORD) {
    const passwordHash = await hashPassword(password);
    const a = await prisma.adminUser.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email: email.toLowerCase(),
        name: "ASL Admin",
        role: "super_admin",
        status: "active",
        passwordHash,
      },
      update: { passwordHash, status: "active", role: "super_admin" },
    });
    await prisma.adminSession.updateMany({
      where: { adminId: a.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { email: a.email, role: a.role };
  },
};
