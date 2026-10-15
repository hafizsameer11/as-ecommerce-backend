import { ModuleRouter } from "@/core/http/router";
import { authLimiter } from "@/core/middleware/rate-limit";
import { adminAuthController as c } from "./admin-auth.controller";
import * as s from "./admin-auth.schemas";

/** asl-admin /login */
export const adminAuthRoutes = new ModuleRouter({ surface: "admin", prefix: "/auth", tag: "Auth" })
  .post("/login", { summary: "Team sign-in", body: s.adminLoginSchema, middleware: [authLimiter] }, c.login)
  .post("/login/2fa", { summary: "Complete sign-in with TOTP", body: s.adminTwoFactorLoginSchema, middleware: [authLimiter] }, c.loginTwoFactor)
  .post("/refresh", { summary: "Rotate refresh token", body: s.adminRefreshSchema }, c.refresh)
  .post("/logout", { summary: "Sign out", auth: "admin" }, c.logout)
  .post("/invite/accept", { summary: "Accept a team invite and set a password", body: s.acceptInviteSchema, middleware: [authLimiter] }, c.acceptInvite)
  .post("/bootstrap", { summary: "One-shot seed admin reset (requires ADMIN_BOOTSTRAP_SECRET)", body: s.adminBootstrapSchema, middleware: [authLimiter] }, c.bootstrap);

/** Top bar profile, density, sidebar state */
export const adminMeRoutes = new ModuleRouter({ surface: "admin", prefix: "/me", tag: "Me", defaultAuth: "admin" })
  .get("/", { summary: "Signed-in team member + effective permissions" }, c.me)
  .patch("/preferences", { summary: "Density, sidebar collapsed, display name", body: s.adminPreferencesSchema }, c.updatePreferences)
  .post("/password", { summary: "Change password", body: s.adminChangePasswordSchema }, c.changePassword)
  .post("/2fa/setup", { summary: "Start TOTP setup" }, c.setupTwoFactor)
  .post("/2fa/enable", { summary: "Confirm TOTP", body: s.adminTotpCodeSchema }, c.enableTwoFactor);
