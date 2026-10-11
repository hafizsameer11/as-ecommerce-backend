import jwt from "jsonwebtoken";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { hashPassword, verifyPassword } from "@/core/auth/password";
import { randomDigits, randomToken, sha256 } from "@/core/auth/tokens";
import { verifyTotp } from "@/core/auth/totp";
import { events } from "@/core/events/bus";
import { env } from "@/config/env";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { createCustomerSession, rotateCustomerSession, type SessionMeta } from "./session.service";
import { toCustomerDto } from "./customer.mapper";
import type { z } from "zod";
import type { registerSchema } from "./auth.schemas";

const OTP_TTL_MS = 10 * 60_000;
const RESET_TTL_MS = 30 * 60_000;

function splitName(v: { name?: string; firstName?: string; lastName?: string }) {
  if (v.firstName) return { firstName: v.firstName, lastName: v.lastName ?? "" };
  const parts = (v.name ?? "").trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

async function uniqueReferralCode(firstName: string) {
  const base = (firstName.replace(/[^a-z]/gi, "").toUpperCase() || "ASL").slice(0, 8);
  for (let i = 0; i < 10; i++) {
    const code = `${base}-ASL${Math.floor(10 + Math.random() * 90)}`;
    if (!(await prisma.customer.findUnique({ where: { referralCode: code } }))) return code;
  }
  return `${base}-${randomToken(4).toUpperCase()}`;
}

async function loadCustomer(id: string) {
  return prisma.customer.findUniqueOrThrow({ where: { id }, include: { twoFactor: { select: { enabledAt: true } } } });
}

async function sessionResponse(customerId: string, meta: SessionMeta) {
  const tokens = await createCustomerSession(customerId, meta);
  await prisma.customer.update({ where: { id: customerId }, data: { lastLoginAt: new Date() } });
  return { ...tokens, customer: toCustomerDto(await loadCustomer(customerId)) };
}

export const authService = {
  async register(input: z.infer<typeof registerSchema>, meta: SessionMeta) {
    const exists = await prisma.customer.findUnique({ where: { email: input.email } });
    if (exists && !exists.deletedAt) throw ApiError.conflict("EMAIL_TAKEN", "An account with this email already exists. Please sign in.");
    const { firstName, lastName } = splitName(input);

    let referredById: string | undefined;
    if (input.referralCode) {
      const adv = await prisma.advocate.findUnique({ where: { code: input.referralCode.toUpperCase() }, select: { customerId: true, status: true } });
      if (adv?.status === "active") referredById = adv.customerId;
    }

    const customer = await prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({
        data: {
          email: input.email,
          firstName,
          lastName,
          phone: input.phone,
          phoneCountry: input.phoneCountry,
          passwordHash: await hashPassword(input.password),
          marketingOptIn: input.marketingOptIn ?? false,
          referralCode: await uniqueReferralCode(firstName),
          referredById,
          wallet: { create: {} },
          stats: { create: {} },
          notificationPref: {
            create: {
              channels: { push: true, email: true, sms: false },
              topics: { orders: true, concierge: true, shipping: true, promos: false, wishlist: true },
            },
          },
        },
      });
      await tx.advocate.create({ data: { customerId: c.id, code: c.referralCode! } });
      return c;
    });

    events.emit("customer.registered", { customerId: customer.id, referralCode: referredById ? input.referralCode : undefined });
    void messaging.email(customer.email, "auth.welcome", { firstName });
    return sessionResponse(customer.id, meta);
  },

  async login(email: string, password: string, meta: SessionMeta) {
    const c = await prisma.customer.findUnique({ where: { email }, include: { twoFactor: true } });
    // same error for unknown email / wrong password (no account enumeration)
    if (!c || c.deletedAt || !c.passwordHash || !(await verifyPassword(c.passwordHash, password)))
      throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.");
    if (c.status === "blocked") throw new ApiError(403, "ACCOUNT_BLOCKED", "This account is not available. Please contact support.");
    if (c.twoFactor?.enabledAt) {
      const challenge = jwt.sign({ purpose: "2fa" }, env.JWT_ACCESS_SECRET, { subject: c.id, audience: "customer-2fa", expiresIn: "5m" });
      return { twoFactorRequired: true as const, challenge };
    }
    events.emit("customer.login", { customerId: c.id });
    return sessionResponse(c.id, meta);
  },

  async loginTwoFactor(challenge: string, code: string, meta: SessionMeta) {
    let sub: string;
    try {
      sub = String((jwt.verify(challenge, env.JWT_ACCESS_SECRET, { audience: "customer-2fa" }) as jwt.JwtPayload).sub);
    } catch {
      throw new ApiError(401, "TOKEN_INVALID", "This sign-in attempt expired. Please sign in again.");
    }
    const tf = await prisma.customerTwoFactor.findUnique({ where: { customerId: sub } });
    if (!tf?.enabledAt) throw new ApiError(401, "TOKEN_INVALID", "Two-factor authentication is not enabled.");
    let ok = verifyTotp(tf.secret, code);
    if (!ok) {
      // recovery code (single use)
      const codes = tf.recoveryCodes as string[];
      const h = sha256(code.replace(/-/g, "").toUpperCase());
      if (codes.includes(h)) {
        ok = true;
        await prisma.customerTwoFactor.update({ where: { customerId: sub }, data: { recoveryCodes: codes.filter((x) => x !== h) } });
      }
    }
    if (!ok) throw new ApiError(401, "TWO_FACTOR_INVALID", "That code didn't work. Please try again.");
    return sessionResponse(sub, meta);
  },

  async requestOtp(target: string, purpose: "login" | "verify_email" | "verify_phone", customerId?: string) {
    const isEmail = target.includes("@");
    const where = isEmail ? { email: target.toLowerCase() } : { phone: target };
    const owner = purpose === "login" ? await prisma.customer.findFirst({ where: { ...where, deletedAt: null } }) : null;
    // login OTP only for existing accounts, but always answer the same way
    if (purpose === "login" && !owner) return { sent: true };
    const code = randomDigits(6);
    await prisma.otpCode.create({
      data: { customerId: owner?.id ?? customerId, target: isEmail ? target.toLowerCase() : target, purpose, codeHash: sha256(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    if (isEmail) await messaging.email(target, "auth.otp", { code });
    else await messaging.sms(target, "auth.otp", { code });
    return { sent: true };
  },

  async verifyOtp(target: string, purpose: "login" | "verify_email" | "verify_phone", code: string, meta: SessionMeta, customerId?: string) {
    const t = target.includes("@") ? target.toLowerCase() : target;
    const otp = await prisma.otpCode.findFirst({ where: { target: t, purpose, usedAt: null }, orderBy: { createdAt: "desc" } });
    if (!otp || otp.expiresAt < new Date() || otp.attempts >= 5) throw ApiError.badRequest("OTP_INVALID", "This code has expired. Request a new one.");
    if (otp.codeHash !== sha256(code)) {
      await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw ApiError.badRequest("OTP_INVALID", "Incorrect code. Please try again.");
    }
    await prisma.otpCode.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    if (purpose === "login") return sessionResponse(otp.customerId!, meta);
    const id = customerId ?? otp.customerId;
    if (!id) throw ApiError.unauthenticated();
    await prisma.customer.update({
      where: { id },
      data: purpose === "verify_email" ? { emailVerifiedAt: new Date() } : { phoneVerifiedAt: new Date(), phone: t },
    });
    return { verified: true };
  },

  async forgotPassword(email: string) {
    const c = await prisma.customer.findUnique({ where: { email } });
    if (c && !c.deletedAt) {
      const token = randomToken();
      await prisma.passwordResetToken.create({ data: { customerId: c.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
      await messaging.email(c.email, "auth.password_reset", {
        firstName: c.firstName,
        // the web/app route that shows the "new password" form
        resetUrl: `${env.APP_URL.replace(/:\d+$/, "")}/auth?mode=reset&token=${token}`,
        token,
      });
    }
    return { sent: true };
  },

  async resetPassword(token: string, password: string) {
    const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw ApiError.badRequest("TOKEN_INVALID", "This reset link has expired. Request a new one.");
    await prisma.$transaction([
      prisma.customer.update({ where: { id: row.customerId }, data: { passwordHash: await hashPassword(password) } }),
      prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      // a password reset signs out every device
      prisma.customerSession.updateMany({ where: { customerId: row.customerId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { reset: true };
  },

  refresh: rotateCustomerSession,

  async logout(sessionId: string) {
    await prisma.customerSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  },
};
