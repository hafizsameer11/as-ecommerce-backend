import { beforeEach, describe, expect, it } from "vitest";
import { api, bearer, registerCustomer } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { mail } from "@/providers/mail/mail";
import { prisma } from "@/core/db/prisma";
import { authenticator } from "../setup/totp";

beforeEach(resetDb);

describe("customer auth", () => {
  it("registers, returns tokens + profile, creates wallet and referral code", async () => {
    const { customer, token } = await registerCustomer({ name: "Amaka Obi" });
    expect(customer.firstName).toBe("Amaka");
    expect(customer.lastName).toBe("Obi");
    expect(customer.tier).toBe("Standard");
    expect(customer.referralCode).toMatch(/^AMAKA-ASL\d{2}$/);
    const me = await api().get("/api/v1/store/me").set(bearer(token));
    expect(me.status).toBe(200);
    expect(await prisma.wallet.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it("rejects duplicate email with EMAIL_TAKEN", async () => {
    const { email } = await registerCustomer();
    const r = await api().post("/api/v1/store/auth/register").send({ name: "X", email, password: "Password123!" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("validates input with field details", async () => {
    const r = await api().post("/api/v1/store/auth/register").send({ email: "bad", password: "1" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
    expect(r.body.error.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(["email", "password"]));
  });

  it("logs in, wrong password gives INVALID_CREDENTIALS", async () => {
    const { email, password } = await registerCustomer();
    const bad = await api().post("/api/v1/store/auth/login").send({ email, password: "nope" });
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    const good = await api().post("/api/v1/store/auth/login").send({ email, password });
    expect(good.status).toBe(200);
    expect(good.body.data.accessToken).toBeTruthy();
    expect(String(good.headers["set-cookie"])).toContain("asl_at=");
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const { refreshToken } = await registerCustomer();
    const r1 = await api().post("/api/v1/store/auth/refresh").send({ refreshToken });
    expect(r1.status).toBe(200);
    const reused = await api().post("/api/v1/store/auth/refresh").send({ refreshToken });
    expect(reused.status).toBe(401);
    // the family is revoked → the newer token stops working too
    const r2 = await api().post("/api/v1/store/auth/refresh").send({ refreshToken: r1.body.data.refreshToken });
    expect(r2.status).toBe(401);
  });

  it("forgot + reset password signs out all sessions", async () => {
    const { email, token } = await registerCustomer();
    await api().post("/api/v1/store/auth/password/forgot").send({ email }).expect(200);
    const msg = mail.outbox!.filter((m) => m.to === email).at(-1)!;
    const resetToken = /token=([\w-]+)/.exec(msg.text!)![1];
    await api().post("/api/v1/store/auth/password/reset").send({ token: resetToken, password: "NewPassword456!" }).expect(200);
    expect((await api().get("/api/v1/store/me").set(bearer(token))).status).toBe(401);
    expect((await api().post("/api/v1/store/auth/login").send({ email, password: "NewPassword456!" })).status).toBe(200);
  });

  it("email OTP login", async () => {
    const { email } = await registerCustomer();
    await api().post("/api/v1/store/auth/otp/request").send({ target: email, purpose: "login" }).expect(200);
    const code = /code is (\d{6})/.exec(mail.outbox!.filter((m) => m.to === email).at(-1)!.text!)![1];
    const wrong = await api().post("/api/v1/store/auth/otp/verify").send({ target: email, purpose: "login", code: code === "000000" ? "111111" : "000000" });
    expect(wrong.body.error.code).toBe("OTP_INVALID");
    const ok = await api().post("/api/v1/store/auth/otp/verify").send({ target: email, purpose: "login", code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
  });

  it("2FA: setup, enable, login requires code", async () => {
    const { email, password, token } = await registerCustomer();
    const setup = await api().post("/api/v1/store/me/2fa/setup").set(bearer(token)).expect(200);
    const secret = setup.body.data.secret;
    const en = await api().post("/api/v1/store/me/2fa/enable").set(bearer(token)).send({ code: authenticator(secret) });
    expect(en.status).toBe(200);
    expect(en.body.data.recoveryCodes).toHaveLength(8);
    const step1 = await api().post("/api/v1/store/auth/login").send({ email, password });
    expect(step1.body.data.twoFactorRequired).toBe(true);
    const step2 = await api().post("/api/v1/store/auth/login/2fa").send({ challenge: step1.body.data.challenge, code: authenticator(secret) });
    expect(step2.status).toBe(200);
    // a recovery code works once
    const s1 = await api().post("/api/v1/store/auth/login").send({ email, password });
    const rc = en.body.data.recoveryCodes[0];
    expect((await api().post("/api/v1/store/auth/login/2fa").send({ challenge: s1.body.data.challenge, code: rc })).status).toBe(200);
    const s2 = await api().post("/api/v1/store/auth/login").send({ email, password });
    expect((await api().post("/api/v1/store/auth/login/2fa").send({ challenge: s2.body.data.challenge, code: rc })).status).toBe(401);
  });
});

describe("account (/me)", () => {
  it("updates profile, preferences, onboarding", async () => {
    const { token } = await registerCustomer();
    const p = await api().patch("/api/v1/store/me").set(bearer(token)).send({ firstName: "John", dateOfBirth: "1995-05-14", gender: "male", phone: "8012345678", phoneCountry: "NG" });
    expect(p.body.data.dateOfBirth).toBe("1995-05-14");
    const pref = await api().patch("/api/v1/store/me/preferences").set(bearer(token)).send({ currency: "USD ($)", privacy: { marketingCookies: true } });
    expect(pref.body.data).toMatchObject({ currency: "USD ($)", language: "English", privacy: { analytics: true, marketingCookies: true } });
    await api().post("/api/v1/store/me/onboarding/complete").set(bearer(token)).expect(200);
    expect((await api().get("/api/v1/store/me").set(bearer(token))).body.data.hasOnboarded).toBe(true);
  });

  it("change password keeps this session, revokes others", async () => {
    const { email, password, token } = await registerCustomer();
    const other = (await api().post("/api/v1/store/auth/login").send({ email, password })).body.data.accessToken;
    const bad = await api().post("/api/v1/store/me/password").set(bearer(token)).send({ currentPassword: "x", newPassword: "NewPassword1!" });
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    await api().post("/api/v1/store/me/password").set(bearer(token)).send({ currentPassword: password, newPassword: "NewPassword1!" }).expect(200);
    expect((await api().get("/api/v1/store/me").set(bearer(token))).status).toBe(200);
    expect((await api().get("/api/v1/store/me").set(bearer(other))).status).toBe(401);
  });

  it("lists sessions and signs out other sessions", async () => {
    const { email, password, token } = await registerCustomer();
    await api().post("/api/v1/store/auth/login").send({ email, password }).set("User-Agent", "Mozilla/5.0 (iPhone) Safari/605.1");
    const list = await api().get("/api/v1/store/me/sessions").set(bearer(token));
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.filter((s: any) => s.current)).toHaveLength(1);
    expect(list.body.data.map((s: any) => s.device)).toContain("iPhone · Safari");
    await api().post("/api/v1/store/me/sessions/revoke-others").set(bearer(token)).expect(200);
    expect((await api().get("/api/v1/store/me/sessions").set(bearer(token))).body.data).toHaveLength(1);
  });

  it("delete account requires DELETE + password and blocks login", async () => {
    const { email, password, token } = await registerCustomer();
    const bad = await api().delete("/api/v1/store/me").set(bearer(token)).send({ confirm: "DELETE", password: "wrong" });
    expect(bad.status).toBe(400);
    await api().delete("/api/v1/store/me").set(bearer(token)).send({ confirm: "DELETE", password }).expect(200);
    expect((await api().post("/api/v1/store/auth/login").send({ email, password })).status).toBe(401);
  });

  it("uploads an avatar (stored as WebP)", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#cc5000" } }).png().toBuffer();
    const { token } = await registerCustomer();
    const r = await api().post("/api/v1/store/me/avatar").set(bearer(token)).attach("file", png, "me.png");
    expect(r.status).toBe(200);
    expect(r.body.data.avatarUrl).toMatch(/\/uploads\/avatars\/.+\.webp$/);
  });
});
