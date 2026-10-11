import { z } from "zod";

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  phoneCountry: z.string().length(2).nullable().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  gender: z.enum(["male", "female", "prefer_not_to_say"]).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be 8+ characters").max(128),
  confirmPassword: z.string().optional(),
}).refine((v) => !v.confirmPassword || v.confirmPassword === v.newPassword, { message: "Passwords don't match", path: ["confirmPassword"] });

export const preferencesSchema = z.object({
  language: z.string().max(40).optional(),
  currency: z.string().max(20).optional(),
  privacy: z.object({ analytics: z.boolean(), personalization: z.boolean(), marketingCookies: z.boolean() }).partial().optional(),
});

export const totpCodeSchema = z.object({ code: z.string().trim().min(6).max(12) });
export const deleteAccountSchema = z.object({ confirm: z.literal("DELETE"), password: z.string().optional() });
export const pushTokenSchema = z.object({ token: z.string().min(10).max(1000), platform: z.enum(["expo", "webpush"]) });
