import { ModuleRouter } from "@/core/http/router";
import { accountController as c } from "./account.controller";
import * as s from "./account.schemas";

/** /account, /account/details, /account/security, /account/settings, onboarding */
export const accountStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me", tag: "Account", defaultAuth: "customer" })
  .get("/", { summary: "Current customer profile" }, c.me)
  .patch("/", { summary: "Update profile (/account/details)", body: s.updateProfileSchema }, c.updateProfile)
  .post("/avatar", { summary: "Upload profile photo (\"Change photo\")", upload: { field: "file", maxMB: 8 }, body: s.avatarBody }, c.uploadAvatar)
  .post("/password", { summary: "Change password (/account/security)", body: s.changePasswordSchema }, c.changePassword)
  .patch("/preferences", { summary: "Language, currency, privacy settings (/account/settings)", body: s.preferencesSchema }, c.updatePreferences)
  .post("/onboarding/complete", { summary: "Mark onboarding done (synced across web + app)" }, c.completeOnboarding)
  .post("/2fa/setup", { summary: "Start TOTP setup → secret + otpauth URL for the QR code" }, c.setupTwoFactor)
  .post("/2fa/enable", { summary: "Confirm TOTP code → returns one-time recovery codes", body: s.totpCodeSchema }, c.enableTwoFactor)
  .post("/2fa/disable", { summary: "Turn off two-factor", body: s.totpCodeSchema }, c.disableTwoFactor)
  .get("/sessions", { summary: "Active sessions" }, c.sessions)
  .delete("/sessions/:id", { summary: "Revoke a session", params: s.sessionIdParam, status: 204 }, c.revokeSession)
  .post("/sessions/revoke-others", { summary: "Sign out all other sessions" }, c.revokeOtherSessions)
  .delete("/", { summary: "Delete account (type DELETE to confirm)", body: s.deleteAccountSchema }, c.deleteAccount)
  .post("/push-tokens", { summary: "Register a push token (Expo / Web Push)", body: s.pushTokenSchema }, c.addPushToken)
  .delete("/push-tokens", { summary: "Unregister a push token", body: s.removePushTokenSchema, status: 204 }, c.removePushToken);
