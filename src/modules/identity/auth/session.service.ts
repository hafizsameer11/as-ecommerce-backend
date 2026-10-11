import type { Request, Response } from "express";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { randomToken, refreshExpiry, sha256, signAccessToken } from "@/core/auth/tokens";
import { CUSTOMER_COOKIE } from "@/core/middleware/auth";
import { env, isProd } from "@/config/env";

export const CUSTOMER_REFRESH_COOKIE = "asl_rt";

export type SessionMeta = { userAgent?: string; ip?: string; device?: string };

export function metaFrom(req: Request): SessionMeta {
  const ua = req.headers["user-agent"]?.slice(0, 500);
  return { userAgent: ua, ip: req.ip, device: (req.header("X-Device-Name") ?? describeUa(ua)).slice(0, 190) };
}

/** "iPhone · Safari" style label shown on the security screen */
export function describeUa(ua?: string) {
  if (!ua) return "Unknown device";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /Expo|okhttp|CFNetwork/.test(ua) ? "ASL app" : "Browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /Expo|okhttp|CFNetwork/.test(ua) ? "App" : "";
  return browser ? `${device} · ${browser}` : device;
}

export async function createCustomerSession(customerId: string, meta: SessionMeta, family = randomToken(12)) {
  const refreshToken = randomToken();
  const session = await prisma.customerSession.create({
    data: {
      customerId,
      refreshTokenHash: sha256(refreshToken),
      family,
      userAgent: meta.userAgent,
      ip: meta.ip,
      device: meta.device,
      expiresAt: refreshExpiry(),
    },
  });
  const accessToken = signAccessToken({ sub: customerId, sid: session.id, aud: "customer" });
  return { accessToken, refreshToken, sessionId: session.id, expiresIn: env.JWT_ACCESS_TTL };
}

/** Rotation with reuse detection: an already-used refresh token revokes the whole family. */
export async function rotateCustomerSession(refreshToken: string, meta: SessionMeta) {
  const hash = sha256(refreshToken);
  const session = await prisma.customerSession.findUnique({ where: { refreshTokenHash: hash } });
  if (!session) throw new ApiError(401, "TOKEN_INVALID", "Your session has expired. Please sign in again.");
  if (session.revokedAt || session.expiresAt < new Date()) {
    if (session.revokedAt) await prisma.customerSession.updateMany({ where: { family: session.family, revokedAt: null }, data: { revokedAt: new Date() } });
    throw new ApiError(401, "TOKEN_INVALID", "Your session has expired. Please sign in again.");
  }
  const next = randomToken();
  await prisma.customerSession.update({
    where: { id: session.id },
    data: { refreshTokenHash: sha256(next), lastUsedAt: new Date(), ip: meta.ip ?? session.ip, expiresAt: refreshExpiry() },
  });
  // the old hash is gone; keep a revoked tombstone so reuse of the old token is detected
  await prisma.customerSession.create({
    data: { customerId: session.customerId, refreshTokenHash: hash, family: session.family, expiresAt: session.expiresAt, revokedAt: new Date(), device: "rotated" },
  });
  return {
    customerId: session.customerId,
    accessToken: signAccessToken({ sub: session.customerId, sid: session.id, aud: "customer" }),
    refreshToken: next,
    sessionId: session.id,
    expiresIn: env.JWT_ACCESS_TTL,
  };
}

/** Web (asl-web) uses httpOnly cookies; the mobile app reads tokens from the body. */
export function setAuthCookies(res: Response, tokens: { accessToken: string; refreshToken: string }) {
  const base = { httpOnly: true, secure: isProd, sameSite: "lax" as const };
  res.cookie(CUSTOMER_COOKIE, tokens.accessToken, { ...base, maxAge: 15 * 60_000, path: "/" });
  res.cookie(CUSTOMER_REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: env.JWT_REFRESH_TTL_DAYS * 86_400_000, path: "/api/v1/store/auth" });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(CUSTOMER_COOKIE, { path: "/" });
  res.clearCookie(CUSTOMER_REFRESH_COOKIE, { path: "/api/v1/store/auth" });
}
