import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { verifyAccessToken, type Audience } from "@/core/auth/tokens";
import { effectivePermissions } from "@/modules/identity/team/team.permissions";
import type { Permission } from "@/core/auth/permissions";

export const CUSTOMER_COOKIE = "asl_at";
export const ADMIN_COOKIE = "asl_admin_at";

function readToken(req: Request, cookie: string) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return (req.cookies?.[cookie] as string | undefined) ?? null;
}

function decode(req: Request, aud: Audience) {
  const token = readToken(req, aud === "admin" ? ADMIN_COOKIE : CUSTOMER_COOKIE);
  if (!token) return null;
  try {
    return verifyAccessToken(token, aud);
  } catch {
    throw new ApiError(401, "TOKEN_INVALID", "Your session has expired. Please sign in again.");
  }
}

export async function optionalCustomer(req: Request, _res: Response, next: NextFunction) {
  const p = decode(req, "customer");
  if (p) req.customer = { id: p.sub, sessionId: p.sid };
  next();
}

export async function requireCustomer(req: Request, _res: Response, next: NextFunction) {
  const p = decode(req, "customer");
  if (!p) throw ApiError.unauthenticated();
  // sessions can be revoked (sign out other devices) → check it is still alive
  const session = await prisma.customerSession.findUnique({
    where: { id: p.sid },
    select: { revokedAt: true, customer: { select: { status: true, deletedAt: true } } },
  });
  if (!session || session.revokedAt) throw new ApiError(401, "TOKEN_INVALID", "Your session has ended. Please sign in again.");
  if (session.customer.status === "blocked" || session.customer.deletedAt)
    throw new ApiError(403, "ACCOUNT_BLOCKED", "This account is not available. Please contact support.");
  req.customer = { id: p.sub, sessionId: p.sid };
  next();
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const p = decode(req, "admin");
  if (!p) throw ApiError.unauthenticated();
  const session = await prisma.adminSession.findUnique({
    where: { id: p.sid },
    select: { revokedAt: true, admin: { select: { id: true, role: true, status: true, name: true, email: true } } },
  });
  if (!session || session.revokedAt) throw new ApiError(401, "TOKEN_INVALID", "Your session has ended. Please sign in again.");
  if (session.admin.status !== "active") throw new ApiError(403, "ACCOUNT_BLOCKED", "This team account is suspended.");
  const a = session.admin;
  req.admin = { id: a.id, sessionId: p.sid, role: a.role, name: a.name, email: a.email, permissions: await effectivePermissions(a.role) };
  next();
}

export function requirePermission(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw ApiError.unauthenticated();
    if (!perms.every((p) => req.admin!.permissions.has(p))) throw ApiError.forbidden();
    next();
  };
}
