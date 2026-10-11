import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { clearAuthCookies } from "../auth/session.service";
import { accountService as svc } from "./account.service";
import type {
  ChangePasswordBody, DeleteAccountBody, PreferencesBody, PushTokenBody, RemovePushTokenBody, TotpCodeBody, UpdateProfileBody,
} from "./account.schemas";

type Id = { id: string };

export const accountController = {
  me: ({ customerId }: Ctx) => svc.me(customerId),
  updateProfile: ({ customerId, body }: Ctx<UpdateProfileBody>) => svc.updateProfile(customerId, body),
  uploadAvatar: ({ customerId, files }: Ctx) => {
    if (!files[0]) throw ApiError.badRequest("VALIDATION_FAILED", "Attach an image in the `file` field.");
    return svc.uploadAvatar(customerId, files[0]);
  },
  changePassword: ({ customerId, req, body }: Ctx<ChangePasswordBody>) =>
    svc.changePassword(customerId, req.customer!.sessionId, body.currentPassword, body.newPassword),
  updatePreferences: ({ customerId, body }: Ctx<PreferencesBody>) => svc.updatePreferences(customerId, body),
  completeOnboarding: ({ customerId }: Ctx) => svc.completeOnboarding(customerId),
  setupTwoFactor: ({ customerId }: Ctx) => svc.setupTwoFactor(customerId),
  enableTwoFactor: ({ customerId, body }: Ctx<TotpCodeBody>) => svc.enableTwoFactor(customerId, body.code),
  disableTwoFactor: ({ customerId, body }: Ctx<TotpCodeBody>) => svc.disableTwoFactor(customerId, body.code),
  sessions: ({ customerId, req }: Ctx) => svc.sessions(customerId, req.customer!.sessionId),
  revokeSession: async ({ customerId, params }: Ctx<unknown, unknown, Id>) => {
    await svc.revokeSession(customerId, params.id);
  },
  revokeOtherSessions: ({ customerId, req }: Ctx) => svc.revokeOtherSessions(customerId, req.customer!.sessionId),
  deleteAccount: async ({ customerId, body, res }: Ctx<DeleteAccountBody>) => {
    const r = await svc.deleteAccount(customerId, body.password);
    clearAuthCookies(res);
    return r;
  },
  addPushToken: ({ customerId, body }: Ctx<PushTokenBody>) => svc.addPushToken(customerId, body.token, body.platform),
  removePushToken: async ({ customerId, body }: Ctx<RemovePushTokenBody>) => {
    await svc.removePushToken(customerId, body.token);
  },
};
