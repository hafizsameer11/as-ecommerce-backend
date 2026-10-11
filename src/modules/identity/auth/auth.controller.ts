import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { authService } from "./auth.service";
import { clearAuthCookies, CUSTOMER_REFRESH_COOKIE, metaFrom, setAuthCookies } from "./session.service";
import type { ForgotBody, LoginBody, OtpRequestBody, OtpVerifyBody, RefreshBody, RegisterBody, ResetBody, TwoFactorLoginBody } from "./auth.schemas";

/** login/register responses carry tokens in the body (mobile) and as httpOnly cookies (web) */
function withCookies<T extends { accessToken?: string; refreshToken?: string }>(ctx: Ctx, r: T) {
  if (r.accessToken && r.refreshToken) setAuthCookies(ctx.res, { accessToken: r.accessToken, refreshToken: r.refreshToken });
  return r;
}

export const authController = {
  register: async (ctx: Ctx<RegisterBody>) => withCookies(ctx, await authService.register(ctx.body, metaFrom(ctx.req))),
  login: async (ctx: Ctx<LoginBody>) => withCookies(ctx, (await authService.login(ctx.body.email, ctx.body.password, metaFrom(ctx.req))) as any),
  loginTwoFactor: async (ctx: Ctx<TwoFactorLoginBody>) => withCookies(ctx, await authService.loginTwoFactor(ctx.body.challenge, ctx.body.code, metaFrom(ctx.req))),
  requestOtp: (ctx: Ctx<OtpRequestBody>) => authService.requestOtp(ctx.body.target, ctx.body.purpose, ctx.req.customer?.id),
  verifyOtp: async (ctx: Ctx<OtpVerifyBody>) =>
    withCookies(ctx, (await authService.verifyOtp(ctx.body.target, ctx.body.purpose, ctx.body.code, metaFrom(ctx.req), ctx.req.customer?.id)) as any),
  forgot: (ctx: Ctx<ForgotBody>) => authService.forgotPassword(ctx.body.email),
  reset: (ctx: Ctx<ResetBody>) => authService.resetPassword(ctx.body.token, ctx.body.password),
  async refresh(ctx: Ctx<RefreshBody>) {
    const token = ctx.body.refreshToken ?? (ctx.req.cookies?.[CUSTOMER_REFRESH_COOKIE] as string | undefined);
    if (!token) throw ApiError.unauthenticated();
    return withCookies(ctx, await authService.refresh(token, metaFrom(ctx.req)));
  },
  async logout(ctx: Ctx) {
    if (ctx.req.customer) await authService.logout(ctx.req.customer.sessionId);
    clearAuthCookies(ctx.res);
    return { signedOut: true };
  },
};
