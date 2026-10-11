import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { newTotpSecret, totpUri, verifyTotp } from "@/core/auth/totp";
import { randomToken, sha256 } from "@/core/auth/tokens";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";
import { defaultPreferences, toCustomerDto } from "../auth/customer.mapper";
import type { z } from "zod";
import type { preferencesSchema, updateProfileSchema } from "./account.schemas";

const load = (id: string) => prisma.customer.findUniqueOrThrow({ where: { id }, include: { twoFactor: { select: { enabledAt: true } } } });

export const accountService = {
  async me(id: string) {
    return toCustomerDto(await load(id));
  },

  async updateProfile(id: string, input: z.infer<typeof updateProfileSchema>) {
    await prisma.customer.update({
      where: { id },
      data: {
        ...input,
        dateOfBirth: input.dateOfBirth === undefined ? undefined : input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      },
    });
    return this.me(id);
  },

  async uploadAvatar(id: string, file: UploadInput) {
    const asset = await mediaService.upload(file, "avatars", `customer:${id}`);
    const url = (asset.variants as Record<string, string> | null)?.sm ?? asset.url;
    await prisma.customer.update({ where: { id }, data: { avatarUrl: url } });
    await mediaService.syncUsage("customer.avatar", id, [asset.url]);
    return this.me(id);
  },

  async changePassword(id: string, sessionId: string, current: string, next: string) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
    if (!c.passwordHash || !(await verifyPassword(c.passwordHash, current)))
      throw ApiError.badRequest("INVALID_CREDENTIALS", "Your current password is incorrect.");
    const min = (await settingsService.get("account")).passwordMinLength;
    if (next.length < min) throw ApiError.badRequest("VALIDATION_FAILED", `Password must be ${min}+ characters`);
    await prisma.$transaction([
      prisma.customer.update({ where: { id }, data: { passwordHash: await hashPassword(next) } }),
      // keep this device signed in, sign out the others
      prisma.customerSession.updateMany({ where: { customerId: id, revokedAt: null, NOT: { id: sessionId } }, data: { revokedAt: new Date() } }),
    ]);
    return { updated: true };
  },

  async updatePreferences(id: string, patch: z.infer<typeof preferencesSchema>) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
    const cur = { ...defaultPreferences, ...((c.preferences as object) ?? {}) } as typeof defaultPreferences;
    const next = { ...cur, ...patch, privacy: { ...cur.privacy, ...(patch.privacy ?? {}) } };
    await prisma.customer.update({ where: { id }, data: { preferences: next } });
    return next;
  },

  async completeOnboarding(id: string) {
    await prisma.customer.update({ where: { id }, data: { hasOnboarded: true } });
    return { hasOnboarded: true };
  },

  // ── two-factor ──
  async setupTwoFactor(id: string) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id }, include: { twoFactor: true } });
    if (c.twoFactor?.enabledAt) throw ApiError.conflict("INVALID_STATE", "Two-factor authentication is already on.");
    const secret = newTotpSecret();
    await prisma.customerTwoFactor.upsert({
      where: { customerId: id },
      create: { customerId: id, secret, recoveryCodes: [] },
      update: { secret, enabledAt: null, recoveryCodes: [] },
    });
    return { secret, otpauthUrl: totpUri(secret, c.email) };
  },

  async enableTwoFactor(id: string, code: string) {
    const tf = await prisma.customerTwoFactor.findUnique({ where: { customerId: id } });
    if (!tf) throw ApiError.badRequest("INVALID_STATE", "Start two-factor setup first.");
    if (!verifyTotp(tf.secret, code)) throw ApiError.badRequest("TWO_FACTOR_INVALID", "That code didn't work. Please try again.");
    const recovery = Array.from({ length: 8 }, () => randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase().padEnd(8, "X"));
    await prisma.customerTwoFactor.update({
      where: { customerId: id },
      data: { enabledAt: new Date(), recoveryCodes: recovery.map((r) => sha256(r)) },
    });
    return { enabled: true, recoveryCodes: recovery };
  },

  async disableTwoFactor(id: string, code: string) {
    const tf = await prisma.customerTwoFactor.findUnique({ where: { customerId: id } });
    if (!tf?.enabledAt) return { enabled: false };
    if (!verifyTotp(tf.secret, code)) throw ApiError.badRequest("TWO_FACTOR_INVALID", "That code didn't work. Please try again.");
    await prisma.customerTwoFactor.delete({ where: { customerId: id } });
    return { enabled: false };
  },

  // ── sessions ("Active Sessions" on /account/security) ──
  async sessions(id: string, currentSessionId: string) {
    const rows = await prisma.customerSession.findMany({
      where: { customerId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: "desc" },
    });
    return rows.map((s) => ({
      id: s.id,
      device: s.device ?? "Unknown device",
      location: s.location ?? s.ip ?? "",
      lastActiveAt: s.lastUsedAt,
      current: s.id === currentSessionId,
      createdAt: s.createdAt,
    }));
  },

  async revokeSession(id: string, sessionId: string) {
    await prisma.customerSession.updateMany({ where: { id: sessionId, customerId: id }, data: { revokedAt: new Date() } });
  },

  async revokeOtherSessions(id: string, currentSessionId: string) {
    const r = await prisma.customerSession.updateMany({
      where: { customerId: id, revokedAt: null, NOT: { id: currentSessionId } },
      data: { revokedAt: new Date() },
    });
    return { revoked: r.count };
  },

  // ── delete account (U8: self-service with a grace period) ──
  async deleteAccount(id: string, password?: string) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id } });
    if (c.passwordHash && (!password || !(await verifyPassword(c.passwordHash, password))))
      throw ApiError.badRequest("INVALID_CREDENTIALS", "Please confirm with your password.");
    const days = (await settingsService.get("account")).deletionGraceDays;
    await prisma.$transaction([
      prisma.customer.update({ where: { id }, data: { deletedAt: new Date(), purgeAfter: new Date(Date.now() + days * 86_400_000), marketingOptIn: false } }),
      prisma.customerSession.updateMany({ where: { customerId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      prisma.pushToken.deleteMany({ where: { customerId: id } }),
    ]);
    return { deleted: true, purgeAfterDays: days };
  },

  // ── push tokens (asl-mobile Expo token / PWA web push) ──
  async addPushToken(id: string, token: string, platform: "expo" | "webpush") {
    const tokenHash = sha256(token);
    await prisma.pushToken.upsert({
      where: { tokenHash },
      create: { customerId: id, token, tokenHash, platform },
      update: { customerId: id },
    });
    return { registered: true };
  },

  async removePushToken(id: string, token: string) {
    await prisma.pushToken.deleteMany({ where: { customerId: id, tokenHash: sha256(token) } });
  },
};
