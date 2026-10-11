import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { clearAuthCookies } from "../auth/session.service";
import { accountService as svc } from "./account.service";
import * as s from "./account.schemas";

/** /account, /account/details, /account/security, /account/settings, onboarding */
export const accountStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me", tag: "Account", defaultAuth: "customer" })
  .get("/", { summary: "Current customer profile" }, ({ customerId }) => svc.me(customerId))
  .patch("/", { summary: "Update profile (/account/details)", body: s.updateProfileSchema }, ({ customerId, body }) => svc.updateProfile(customerId, body))
  .post("/avatar", {
    summary: "Upload profile photo (\"Change photo\")",
    upload: { field: "file", maxMB: 8 },
    body: z.object({ file: z.any().optional() }),
  }, ({ customerId, files }) => {
    if (!files[0]) throw ApiError.badRequest("VALIDATION_FAILED", "Attach an image in the `file` field.");
    return svc.uploadAvatar(customerId, files[0]);
  })
  .post("/password", { summary: "Change password (/account/security)", body: s.changePasswordSchema }, ({ customerId, req, body }) =>
    svc.changePassword(customerId, req.customer!.sessionId, body.currentPassword, body.newPassword))
  .patch("/preferences", { summary: "Language, currency, privacy settings (/account/settings)", body: s.preferencesSchema }, ({ customerId, body }) =>
    svc.updatePreferences(customerId, body))
  .post("/onboarding/complete", { summary: "Mark onboarding done (synced across web + app)" }, ({ customerId }) => svc.completeOnboarding(customerId))
  .post("/2fa/setup", { summary: "Start TOTP setup → secret + otpauth URL for the QR code" }, ({ customerId }) => svc.setupTwoFactor(customerId))
  .post("/2fa/enable", { summary: "Confirm TOTP code → returns one-time recovery codes", body: s.totpCodeSchema }, ({ customerId, body }) =>
    svc.enableTwoFactor(customerId, body.code))
  .post("/2fa/disable", { summary: "Turn off two-factor", body: s.totpCodeSchema }, ({ customerId, body }) => svc.disableTwoFactor(customerId, body.code))
  .get("/sessions", { summary: "Active sessions" }, ({ customerId, req }) => svc.sessions(customerId, req.customer!.sessionId))
  .delete("/sessions/:id", { summary: "Revoke a session", params: z.object({ id: z.string() }), status: 204 }, async ({ customerId, params }) => {
    await svc.revokeSession(customerId, params.id);
  })
  .post("/sessions/revoke-others", { summary: "Sign out all other sessions" }, ({ customerId, req }) => svc.revokeOtherSessions(customerId, req.customer!.sessionId))
  .delete("/", { summary: "Delete account (type DELETE to confirm)", body: s.deleteAccountSchema }, async ({ customerId, body, res }) => {
    const r = await svc.deleteAccount(customerId, body.password);
    clearAuthCookies(res);
    return r;
  })
  .post("/push-tokens", { summary: "Register a push token (Expo / Web Push)", body: s.pushTokenSchema }, ({ customerId, body }) =>
    svc.addPushToken(customerId, body.token, body.platform))
  .delete("/push-tokens", { summary: "Unregister a push token", body: z.object({ token: z.string() }), status: 204 }, async ({ customerId, body }) => {
    await svc.removePushToken(customerId, body.token);
  });
