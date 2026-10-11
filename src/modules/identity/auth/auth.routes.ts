import { ModuleRouter } from "@/core/http/router";
import { authLimiter, otpLimiter } from "@/core/middleware/rate-limit";
import { authController as c } from "./auth.controller";
import * as s from "./auth.schemas";

/** /auth screen, login modal, onboarding */
export const authStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/auth", tag: "Auth" })
  .post("/register", { summary: "Create account (sign up)", body: s.registerSchema, status: 201, middleware: [authLimiter] }, c.register)
  .post("/login", {
    summary: "Sign in with email + password",
    description: "Returns tokens, or `{ twoFactorRequired: true, challenge }` when 2FA is on → POST /auth/login/2fa.",
    body: s.loginSchema,
    middleware: [authLimiter],
  }, c.login)
  .post("/login/2fa", { summary: "Complete sign-in with a TOTP or recovery code", body: s.twoFactorLoginSchema, middleware: [authLimiter] }, c.loginTwoFactor)
  .post("/otp/request", { summary: "Send a one-time code (login / verify email / verify phone)", auth: "optionalCustomer", body: s.otpRequestSchema, middleware: [otpLimiter] }, c.requestOtp)
  .post("/otp/verify", { summary: "Verify a one-time code", auth: "optionalCustomer", body: s.otpVerifySchema, middleware: [authLimiter] }, c.verifyOtp)
  .post("/password/forgot", { summary: "Email a password reset link", body: s.forgotSchema, middleware: [otpLimiter] }, c.forgot)
  .post("/password/reset", { summary: "Set a new password from a reset link", body: s.resetSchema, middleware: [authLimiter] }, c.reset)
  .post("/refresh", { summary: "Rotate refresh token (body for mobile, cookie for web)", body: s.refreshSchema }, c.refresh)
  .post("/logout", { summary: "Sign out this device", auth: "optionalCustomer" }, c.logout);
