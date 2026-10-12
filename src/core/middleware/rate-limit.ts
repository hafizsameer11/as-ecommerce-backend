import rateLimit from "express-rate-limit";
import { isTest } from "@/config/env";

const base = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => isTest,
    handler: (req, res) =>
      res.status(429).json({ error: { code: "RATE_LIMITED", message, requestId: req.id } }),
  });

export const authLimiter = base(60_000, 10, "Too many attempts. Please wait a minute and try again.");
export const otpLimiter = base(10 * 60_000, 5, "Too many codes requested. Please wait a few minutes.");
export const lookupLimiter = base(60_000, 20, "Too many lookups. Please wait a minute.");
export const publicLimiter = base(60_000, 300, "Too many requests. Please slow down.");
