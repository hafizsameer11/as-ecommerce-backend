import { z } from "zod";

const email = z.string().trim().toLowerCase().email().max(190);
const password = z.string().min(8, "Password must be 8+ characters").max(128);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  email,
  phone: z.string().trim().max(30).optional(),
  phoneCountry: z.string().length(2).optional(),
  password,
  referralCode: z.string().trim().max(40).optional(),
  marketingOptIn: z.boolean().optional(),
}).refine((v) => v.name || v.firstName, { message: "Name is required", path: ["name"] });

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const twoFactorLoginSchema = z.object({ challenge: z.string().min(10), code: z.string().trim().min(6).max(12) });
export const otpRequestSchema = z.object({
  target: z.string().trim().min(5).max(190),
  purpose: z.enum(["login", "verify_email", "verify_phone"]).default("login"),
});
export const otpVerifySchema = otpRequestSchema.extend({ code: z.string().trim().length(6) });
export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ token: z.string().min(20), password });
export const refreshSchema = z.object({ refreshToken: z.string().min(20).optional() });

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type TwoFactorLoginBody = z.infer<typeof twoFactorLoginSchema>;
export type OtpRequestBody = z.infer<typeof otpRequestSchema>;
export type OtpVerifyBody = z.infer<typeof otpVerifySchema>;
export type ForgotBody = z.infer<typeof forgotSchema>;
export type ResetBody = z.infer<typeof resetSchema>;
export type RefreshBody = z.infer<typeof refreshSchema>;
