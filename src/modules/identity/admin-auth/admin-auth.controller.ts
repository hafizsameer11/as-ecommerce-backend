import type { Response } from "express";
import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { metaFrom } from "../auth/session.service";
import { ADMIN_REFRESH_COOKIE, adminAuthService as svc, adminProfile, clearAdminCookies, setAdminCookies } from "./admin-auth.service";
import type {
  AcceptInviteBody, AdminChangePasswordBody, AdminLoginBody, AdminPreferencesBody, AdminRefreshBody, AdminTotpCodeBody, AdminTwoFactorLoginBody,
} from "./admin-auth.schemas";

/** Responses carrying tokens also set the httpOnly admin cookies. */
const withCookies = <T>(res: Response, r: T): T => {
  if ((r as any).accessToken) setAdminCookies(res, r as any);
  return r;
};

export const adminAuthController = {
  // /auth
  login: async ({ body, req, res }: Ctx<AdminLoginBody>) => withCookies(res, await svc.login(body.email, body.password, metaFrom(req))),
  loginTwoFactor: async ({ body, req, res }: Ctx<AdminTwoFactorLoginBody>) => withCookies(res, await svc.loginTwoFactor(body.challenge, body.code, metaFrom(req))),
  refresh: async ({ body, req, res }: Ctx<AdminRefreshBody>) => {
    const t = body.refreshToken ?? req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!t) throw ApiError.unauthenticated();
    return withCookies(res, await svc.refresh(t, metaFrom(req)));
  },
  logout: async ({ admin, res }: Ctx) => {
    await svc.logout(admin.sessionId);
    clearAdminCookies(res);
    return { signedOut: true };
  },
  acceptInvite: async ({ body, req, res }: Ctx<AcceptInviteBody>) => withCookies(res, await svc.acceptInvite(body.token, body.password, metaFrom(req))),

  // /me
  me: ({ admin }: Ctx) => adminProfile(admin.id),
  updatePreferences: ({ admin, body }: Ctx<AdminPreferencesBody>) => svc.updatePreferences(admin.id, body),
  changePassword: ({ admin, body }: Ctx<AdminChangePasswordBody>) => svc.changePassword(admin.id, body.currentPassword, body.newPassword),
  setupTwoFactor: ({ admin }: Ctx) => svc.setupTwoFactor(admin.id),
  enableTwoFactor: ({ admin, body }: Ctx<AdminTotpCodeBody>) => svc.enableTwoFactor(admin.id, body.code),
};
