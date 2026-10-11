import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { authLimiter } from "@/core/middleware/rate-limit";
import { metaFrom } from "../auth/session.service";
import { ADMIN_REFRESH_COOKIE, adminAuthService as svc, adminProfile, clearAdminCookies, setAdminCookies } from "./admin-auth.service";

const login = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });
const withCookies = (res: any, r: any) => {
  if (r.accessToken) setAdminCookies(res, r);
  return r;
};

/** asl-admin /login */
export const adminAuthRoutes = new ModuleRouter({ surface: "admin", prefix: "/auth", tag: "Auth" })
  .post("/login", { summary: "Team sign-in", body: login, middleware: [authLimiter] }, async ({ body, req, res }) =>
    withCookies(res, await svc.login(body.email, body.password, metaFrom(req))))
  .post("/login/2fa", { summary: "Complete sign-in with TOTP", body: z.object({ challenge: z.string(), code: z.string().min(6) }), middleware: [authLimiter] },
    async ({ body, req, res }) => withCookies(res, await svc.loginTwoFactor(body.challenge, body.code, metaFrom(req))))
  .post("/refresh", { summary: "Rotate refresh token", body: z.object({ refreshToken: z.string().optional() }) }, async ({ body, req, res }) => {
    const t = body.refreshToken ?? req.cookies?.[ADMIN_REFRESH_COOKIE];
    if (!t) throw ApiError.unauthenticated();
    return withCookies(res, await svc.refresh(t, metaFrom(req)));
  })
  .post("/logout", { summary: "Sign out", auth: "admin" }, async ({ admin, res }) => {
    await svc.logout(admin.sessionId);
    clearAdminCookies(res);
    return { signedOut: true };
  })
  .post("/invite/accept", { summary: "Accept a team invite and set a password", body: z.object({ token: z.string().min(20), password: z.string().min(10, "Use at least 10 characters") }), middleware: [authLimiter] },
    async ({ body, req, res }) => withCookies(res, await svc.acceptInvite(body.token, body.password, metaFrom(req))));

/** Top bar profile, density, sidebar state */
export const adminMeRoutes = new ModuleRouter({ surface: "admin", prefix: "/me", tag: "Me", defaultAuth: "admin" })
  .get("/", { summary: "Signed-in team member + effective permissions" }, ({ admin }) => adminProfile(admin.id))
  .patch("/preferences", {
    summary: "Density, sidebar collapsed, display name",
    body: z.object({ density: z.enum(["comfortable", "cozy", "compact"]).optional(), sidebarCollapsed: z.boolean().optional(), name: z.string().min(1).max(80).optional() }),
  }, ({ admin, body }) => svc.updatePreferences(admin.id, body))
  .post("/password", { summary: "Change password", body: z.object({ currentPassword: z.string(), newPassword: z.string().min(10) }) }, ({ admin, body }) =>
    svc.changePassword(admin.id, body.currentPassword, body.newPassword))
  .post("/2fa/setup", { summary: "Start TOTP setup" }, ({ admin }) => svc.setupTwoFactor(admin.id))
  .post("/2fa/enable", { summary: "Confirm TOTP", body: z.object({ code: z.string().min(6) }) }, ({ admin, body }) => svc.enableTwoFactor(admin.id, body.code));
