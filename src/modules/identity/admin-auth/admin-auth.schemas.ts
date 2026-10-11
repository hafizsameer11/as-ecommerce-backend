import { z } from "zod";

export const adminLoginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });
export const adminTwoFactorLoginSchema = z.object({ challenge: z.string(), code: z.string().min(6) });
export const adminRefreshSchema = z.object({ refreshToken: z.string().optional() });
export const acceptInviteSchema = z.object({ token: z.string().min(20), password: z.string().min(10, "Use at least 10 characters") });

export const adminPreferencesSchema = z.object({
  density: z.enum(["comfortable", "cozy", "compact"]).optional(),
  sidebarCollapsed: z.boolean().optional(),
  name: z.string().min(1).max(80).optional(),
});
export const adminChangePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string().min(10) });
export const adminTotpCodeSchema = z.object({ code: z.string().min(6) });

export type AdminLoginBody = z.infer<typeof adminLoginSchema>;
export type AdminTwoFactorLoginBody = z.infer<typeof adminTwoFactorLoginSchema>;
export type AdminRefreshBody = z.infer<typeof adminRefreshSchema>;
export type AcceptInviteBody = z.infer<typeof acceptInviteSchema>;
export type AdminPreferencesBody = z.infer<typeof adminPreferencesSchema>;
export type AdminChangePasswordBody = z.infer<typeof adminChangePasswordSchema>;
export type AdminTotpCodeBody = z.infer<typeof adminTotpCodeSchema>;
