import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "@/config/env";

export type Audience = "customer" | "admin";
export type AccessPayload = { sub: string; sid: string; aud: Audience; role?: string };

export function signAccessToken(p: { sub: string; sid: string; aud: Audience; role?: string }) {
  return jwt.sign({ sid: p.sid, role: p.role }, env.JWT_ACCESS_SECRET, {
    subject: p.sub,
    audience: p.aud,
    issuer: "asl-backend",
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string, aud: Audience): AccessPayload {
  const d = jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: aud, issuer: "asl-backend" }) as jwt.JwtPayload;
  return { sub: String(d.sub), sid: String(d.sid), aud, role: d.role };
}

/** Opaque random token (refresh tokens, reset links, invites, guest tokens). */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomDigits(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += crypto.randomInt(0, 10).toString();
  return s;
}

export function refreshExpiry() {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
}

/** HMAC signature for guest-facing links (order lookup, pay links). */
export function sign(value: string) {
  return crypto.createHmac("sha256", env.JWT_REFRESH_SECRET).update(value).digest("base64url").slice(0, 32);
}
