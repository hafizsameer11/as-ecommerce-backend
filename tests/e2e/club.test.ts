import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";
import { clubService } from "@/modules/loyalty/club/club.service";
import { pointsService } from "@/modules/loyalty/club/points.service";
import { referralsService } from "@/modules/loyalty/referrals/referrals.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const SIGNUP = 250; // club.signupBonus default

let admin: string;
let support: string;
let marketing: string;

type Pick = { handle: string; productId: string; variantId: string; size: string | null; color: string | null; price: number };

async function pickProduct(min: number, max: number, minFree = 3): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: min, lte: max } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= minFree);
    if (v) return { handle: p.handle, productId: p.id, variantId: v.id, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error(`no product between ${min} and ${max}`);
}

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

/** bag → checkout → place → pay with the mock gateway; returns the order */
async function buy(c: { token: string; email: string }, p: Pick, coupon?: string) {
  const add = await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 });
  expect(add.status).toBe(201);
  await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos, paymentMethod: "card" });
  let discount = 0;
  if (coupon) {
    const ap = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: coupon });
    expect(ap.status).toBe(200);
    discount = ap.body.data.checkout.totals.discount;
  }
  const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
  expect(r.status).toBe(201);
  const pay = await api().post(`${W}/mock/checkout/${r.body.data.payment.reference}/complete`).type("form").send({ outcome: "success" });
  expect(pay.status).toBe(200);
  await settle();
  const order = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
  expect(order.paymentStatus).toBe("paid");
  return { order, discount };
}

const club = (token: string) => api().get(`${S}/me/club`).set(bearer(token));
const redeem = (token: string, id: string) => api().post(`${S}/me/club/rewards/${id}/redeem`).set(bearer(token)).set("Idempotency-Key", uniq("rd"));

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  support = (await createAdmin("support")).token;
  marketing = (await createAdmin("marketing")).token;
}, 240_000);

describe("earning + tiers", () => {
  it("earns floor((subtotal − discount) / ₦100) × tier multiplier on a paid order, journaled as a liability", async () => {
    const c = await registerCustomer();
    await settle();
    expect((await club(c.token)).body.data.points).toBe(SIGNUP);
    await prisma.customer.update({ where: { id: c.customer.id }, data: { tier: "Gold" } }); // 1.25×

    const p = await pickProduct(N(20_000), N(70_000));
    const { order } = await buy(c, p);
    const expected = Math.floor((Math.floor((order.subtotal - order.discount) / N(100)) * 125) / 100);
    expect(expected).toBeGreaterThan(0);

    const s = await club(c.token);
    expect(s.status).toBe(200);
    expect(s.body.data.points).toBe(SIGNUP + expected);
    expect(s.body.data.pointsValue).toBe((SIGNUP + expected) * 500);
    expect(s.body.data.tier.id).toBe("Gold");
    expect(s.body.data.multiplier).toBe(1.25);
    expect(s.body.data.nextTier.id).toBe("Signature");
    expect(s.body.data.spendToNext).toBe(N(7_500_000) - Number(order.total));

    const h = await api().get(`${S}/me/club/history`).set(bearer(c.token));
    expect(h.body.data[0]).toMatchObject({ kind: "order", delta: expected, title: "Points Earned" });
    expect(h.body.meta.total).toBe(2);

    const entry = await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "order" } });
    expect(entry.remaining).toBe(expected);
    expect(entry.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 700 * 86_400_000);
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `PTS-${entry.id}` }, include: { lines: true } });
    expect(je.lines.find((l) => l.accountCode === "2300")!.credit).toBe(BigInt(expected * 500));
    expect(je.lines.find((l) => l.accountCode === "5300")!.debit).toBe(BigInt(expected * 500));

    // paid again (duplicate event) → no double earn
    await clubService.earnForOrder(order.id);
    expect(await prisma.pointsEntry.count({ where: { customerId: c.customer.id, refType: "order" } })).toBe(1);
  });

  it("upgrades as soon as the 12-month spend crosses a threshold; the nightly run downgrades", async () => {
    const c = await registerCustomer();
    await prisma.customerStats.update({ where: { customerId: c.customer.id }, data: { spend12m: BigInt(N(500_000) - 1) } });
    const p = await pickProduct(N(20_000), N(70_000));
    const { order } = await buy(c, p);
    const me = await prisma.customer.findUniqueOrThrow({ where: { id: c.customer.id } });
    expect(me.tier).toBe("Silver");
    // earned at the tier held when buying (Standard 1×)
    const earn = await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "order" } });
    expect(earn.delta).toBe(Math.floor((order.subtotal - order.discount) / N(100)));
    expect(await prisma.auditEvent.count({ where: { action: "club.tier_changed", entityId: c.customer.id } })).toBe(1);

    // nightly: the real 12-month spend is just this order → back to Standard
    await clubService.recomputeTiers();
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: c.customer.id }, include: { stats: true } });
    expect(after.tier).toBe("Standard");
    expect(Number(after.stats!.spend12m)).toBe(order.amountPaid);
  });
});

describe("rewards", () => {
  it("lists the catalogue with lock reasons and refuses when points are short (400) or tier not eligible", async () => {
    const c = await registerCustomer();
    await settle();
    const list = await api().get(`${S}/me/club/rewards`).set(bearer(c.token));
    expect(list.status).toBe(200);
    expect(list.body.meta.points).toBe(SIGNUP);
    const coupon = list.body.data.find((r: any) => r.id === "rw_coupon_10");
    expect(coupon).toMatchObject({ canRedeem: false, lockedReason: `${(1200 - SIGNUP).toLocaleString("en-NG")} more points needed` });
    expect(list.body.data.find((r: any) => r.id === "rw_vip_event").lockedReason).toBe("For Gold and Signature members");

    const short = await redeem(c.token, "rw_coupon_10");
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe("INSUFFICIENT_POINTS");
    const tier = await redeem(c.token, "rw_vip_event");
    expect(tier.status).toBe(400);
    expect((await club(c.token)).body.data.points).toBe(SIGNUP);
    expect((await prisma.clubReward.findUniqueOrThrow({ where: { id: "rw_coupon_10" } })).redeemedCount).toBe(0);
  });

  it("redeems a 10% coupon (FIFO), then the code works once at checkout", async () => {
    const c = await registerCustomer();
    await settle();
    const adj = await api().post(`${A}/club/points/adjust`).set(bearer(admin)).send({ customerId: c.customer.id, delta: 1000, reason: "Goodwill" });
    expect(adj.status).toBe(200);
    expect(adj.body.data.points).toBe(SIGNUP + 1000);
    // the welcome lot expires first → it is spent first
    const welcome = await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "signup" } });
    await prisma.pointsEntry.update({ where: { id: welcome.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } });

    const r = await redeem(c.token, "rw_coupon_10");
    expect(r.status).toBe(201);
    const code = r.body.data.redemption.couponCode as string;
    expect(code).toMatch(/^ASL10[A-Z0-9]{5}$/);
    expect(r.body.data.redemption.status).toBe("fulfilled");
    expect(r.body.data.points).toBe(SIGNUP + 1000 - 1200);
    expect((await prisma.pointsEntry.findUniqueOrThrow({ where: { id: welcome.id } })).remaining).toBe(0);
    const goodwill = await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "adjustment" } });
    expect(goodwill.remaining).toBe(SIGNUP + 1000 - 1200);
    await settle();

    const mine = await api().get(`${S}/me/coupons`).set(bearer(c.token));
    expect(mine.body.data.map((x: any) => x.code)).toContain(code);
    const reds = await api().get(`${S}/me/club/redemptions`).set(bearer(c.token));
    expect(reds.body.data[0]).toMatchObject({ couponCode: code, points: 1200, statusLabel: "Fulfilled" });

    // liability released: Dr 2300 / Cr 5300 at 1200 × ₦5
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `RDM-${r.body.data.redemption.id}` }, include: { lines: true } });
    expect(je.lines.find((l) => l.accountCode === "2300")!.debit).toBe(BigInt(1200 * 500));

    const p = await pickProduct(N(20_000), N(70_000));
    const { order, discount } = await buy(c, p, code);
    expect(discount).toBe(Math.round(order.subtotal * 0.1));
    expect(order.discount).toBe(discount);
    expect((await prisma.customerCoupon.findUniqueOrThrow({ where: { code } })).usedAt).not.toBeNull();
    // single use
    await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 });
    const again = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("COUPON_LIMIT_REACHED");
  });

  it("redeems store credit into the wallet (Dr 2300 / Cr 2000)", async () => {
    const c = await registerCustomer();
    await settle();
    await pointsService.apply(c.customer.id, 500, { kind: "adjustment", reason: "test" });
    const r = await redeem(c.token, "rw_credit_2500");
    expect(r.status).toBe(201);
    expect(r.body.data.redemption.amount).toBe(N(2_500));
    expect((await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data.balance).toBe(N(2_500));
    expect((await club(c.token)).body.data.credit).toBe(N(2_500));
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `RDM-${r.body.data.redemption.id}` }, include: { lines: true } });
    expect(je.lines.find((l) => l.accountCode === "2000")!.credit).toBe(BigInt(N(2_500)));
    expect(je.lines.find((l) => l.accountCode === "2300")!.debit).toBe(BigInt(500 * 500));
    // the cancel of a paid-out credit is refused
    const cancel = await api().post(`${A}/club/redemptions/${r.body.data.redemption.id}/cancel`).set(bearer(admin)).send({ reason: "test" });
    expect(cancel.status).toBe(409);
  });

  it("staff fulfil or cancel pending rewards (cancel returns the points)", async () => {
    const c = await registerCustomer();
    await settle();
    await pointsService.apply(c.customer.id, 4000, { kind: "adjustment", reason: "test" });
    const gift = await redeem(c.token, "rw_gift_box");
    expect(gift.body.data.redemption.status).toBe("pending");
    const gift2 = await redeem(c.token, "rw_gift_box");
    const before = (await club(c.token)).body.data.points;

    const list = await api().get(`${A}/club/redemptions`).query({ status: "pending", customerId: c.customer.id }).set(bearer(support));
    expect(list.status).toBe(200);
    expect(list.body.meta.tabs.pending).toBe(2);

    const ok = await api().post(`${A}/club/redemptions/${gift.body.data.redemption.id}/fulfil`).set(bearer(marketing)).send({ note: "Couriered" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("fulfilled");
    const cancel = await api().post(`${A}/club/redemptions/${gift2.body.data.redemption.id}/cancel`).set(bearer(marketing)).send({ reason: "Out of boxes" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("cancelled");
    expect((await club(c.token)).body.data.points).toBe(before + 2000);
    expect((await prisma.clubReward.findUniqueOrThrow({ where: { id: "rw_gift_box" } })).redeemedCount).toBe(1);
  });
});

describe("refunds + expiry", () => {
  it("a partial then full refund takes the points back in proportion", async () => {
    const c = await registerCustomer();
    await settle();
    const p = await pickProduct(N(40_000), N(140_000));
    const { order } = await buy(c, p);
    const earned = (await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "order" } })).delta;
    expect((await club(c.token)).body.data.points).toBe(SIGNUP + earned);

    const half = Math.floor(order.amountPaid / 2);
    const r1 = await api().post(`${A}/orders/${order.id}/refund`).set(bearer(admin)).send({ amount: half, reason: "Partial refund", to: "wallet" });
    expect(r1.status).toBe(200);
    await settle();
    const firstBack = Math.round(earned * (half / order.amountPaid));
    expect((await club(c.token)).body.data.points).toBe(SIGNUP + earned - firstBack);

    const r2 = await api().post(`${A}/orders/${order.id}/refund`).set(bearer(admin)).send({ reason: "Rest of it", to: "wallet" });
    expect(r2.status).toBe(200);
    await settle();
    expect((await club(c.token)).body.data.points).toBe(SIGNUP);
    const rev = await prisma.pointsEntry.findMany({ where: { customerId: c.customer.id, refType: "order_reversal" } });
    expect(rev.reduce((n, e) => n + e.delta, 0)).toBe(-earned);
    // released liability journaled Dr 2300
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `PTS-${rev[0].id}` }, include: { lines: true } });
    expect(je.lines.find((l) => l.accountCode === "2300")!.debit).toBe(BigInt(-rev[0].delta * 500));
  });

  it("customer cancel of a paid order reverses its points", async () => {
    const c = await registerCustomer();
    await settle();
    const p = await pickProduct(N(20_000), N(70_000));
    const { order } = await buy(c, p);
    const cancel = await api().post(`${S}/me/orders/${order.number}/cancel`).set(bearer(c.token)).send({ reason: "Changed my mind" });
    expect(cancel.status).toBe(200);
    await settle();
    expect((await club(c.token)).body.data.points).toBe(SIGNUP);
  });

  it("expiry job removes lots past their date and shows what expires soon", async () => {
    const c = await registerCustomer();
    await settle();
    const lot = await pointsService.apply(c.customer.id, 300, { kind: "adjustment", reason: "Old points" });
    await prisma.pointsEntry.update({ where: { id: lot!.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const soon = await pointsService.apply(c.customer.id, 70, { kind: "adjustment", reason: "Soon" });
    await prisma.pointsEntry.update({ where: { id: soon!.id }, data: { expiresAt: new Date(Date.now() + 5 * 86_400_000) } });

    // expired lots are already unusable before the job runs
    expect((await club(c.token)).body.data.points).toBe(SIGNUP + 70);
    const r = await pointsService.expireDue();
    expect(r.points).toBeGreaterThanOrEqual(300);
    const exp = await prisma.pointsEntry.findFirstOrThrow({ where: { customerId: c.customer.id, refType: "expiry" } });
    expect(exp.delta).toBe(-300);
    expect((await prisma.pointsEntry.findUniqueOrThrow({ where: { id: lot!.id } })).remaining).toBe(0);
    const s = (await club(c.token)).body.data;
    expect(s.points).toBe(SIGNUP + 70);
    expect(s.expiringSoon.points).toBe(70);
    // running again changes nothing
    await pointsService.expireDue();
    expect(await prisma.pointsEntry.count({ where: { customerId: c.customer.id, refType: "expiry" } })).toBe(1);
  });
});

describe("referrals", () => {
  it("sign-up with a code → friend's first order → qualify job → advocate rewarded", async () => {
    const adv = await registerCustomer({ name: "Ada Obi" });
    const me = await api().get(`${S}/me/referrals`).set(bearer(adv.token));
    expect(me.status).toBe(200);
    const code = me.body.data.code as string;
    expect(code).toMatch(/^ADA-/);
    expect(me.body.data.link).toMatch(new RegExp(`/r/${code}$`));
    expect(me.body.data.friendReward.label).toBe("10% off their first order");

    const click = await api().post(`${S}/referrals/click/${code.toLowerCase()}`).send({});
    expect(click.status).toBe(200);
    expect(click.body.data.advocateFirstName).toBe("Ada");
    expect((await api().post(`${S}/referrals/click/NOPE-123`).send({})).status).toBe(404);

    mail.outbox!.length = 0;
    const email = `${uniq("friend")}@test.dev`;
    const reg = await api().post(`${S}/auth/register`).send({ name: "Tunde Bello", email, password: "Password123!", referralCode: code });
    expect(reg.status).toBe(201);
    const friend = { token: reg.body.data.accessToken as string, email, id: reg.body.data.customer.id as string };
    await settle();

    const ref = await prisma.referral.findUniqueOrThrow({ where: { friendCustomerId: friend.id } });
    expect(ref.status).toBe("pending");
    const welcome = await prisma.customerCoupon.findFirstOrThrow({ where: { customerId: friend.id, source: "referral" } });
    expect(welcome).toMatchObject({ type: "percent", value: 10 });
    expect(mail.outbox!.some((m) => m.to === email && m.subject.includes("Ada"))).toBe(true);

    const p = await pickProduct(N(60_000), N(400_000));
    const { order } = await buy(friend, p, welcome.code);
    expect(order.discount).toBe(Math.round(order.subtotal * 0.1));
    const attached = await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } });
    expect(attached.orderId).toBe(order.id);
    expect(attached.spend).toBe(order.subtotal - order.discount);

    // not delivered yet → still pending
    expect((await referralsService.qualifyDue()).qualified).toBe(0);
    // delivered 8 days ago (return window 7) and not refunded
    await prisma.order.update({ where: { id: order.id }, data: { status: "delivered", deliveredAt: new Date(Date.now() - 8 * 86_400_000) } });
    const run = await referralsService.qualifyDue();
    expect(run).toMatchObject({ qualified: 1, rewarded: 1 });
    await settle();

    const done = await prisma.referral.findUniqueOrThrow({ where: { id: ref.id } });
    expect(done.status).toBe("rewarded");
    expect(done.reward).toBe(N(15_000));
    expect((await api().get(`${S}/me/wallet`).set(bearer(adv.token))).body.data.balance).toBe(N(15_000));
    const credit = await prisma.walletTransaction.findFirstOrThrow({ where: { wallet: { customerId: adv.customer.id }, kind: "credit" } });
    expect(await prisma.journalEntry.count({ where: { reference: credit.reference } })).toBe(1); // Dr 5300 / Cr 2000

    const mine = await api().get(`${S}/me/referrals`).set(bearer(adv.token));
    expect(mine.body.data.stats).toMatchObject({ clicks: 1, invited: 1, joined: 1, earned: N(15_000) });
    expect(mine.body.data.friends[0]).toMatchObject({ name: "Tunde B.", status: "rewarded", reward: N(15_000) });

    const list = await api().get(`${A}/referrals`).query({ status: "rewarded" }).set(bearer(support));
    expect(list.status).toBe(200);
    expect(list.body.meta.tabs.rewarded).toBeGreaterThanOrEqual(1);
    expect(list.body.data.find((r: any) => r.id === ref.id)).toMatchObject({ orderNumber: order.number, advocateCode: code });
    const ov = await api().get(`${A}/referrals/overview`).set(bearer(admin));
    expect(ov.body.data.kpis.rewardsPaid).toBeGreaterThanOrEqual(N(15_000));
    const advs = await api().get(`${A}/referrals/advocates`).set(bearer(admin));
    expect(advs.body.data.find((a: any) => a.code === code)).toMatchObject({ clicks: 1, signups: 1, qualified: 1, rewardsEarnedMinor: N(15_000) });
  });

  it("blocks self-referrals (same mailbox) and expires referrals whose order was refunded", async () => {
    const base = uniq("sam");
    const adv = await registerCustomer({ name: "Sam Self", email: `${base}@test.dev` });
    const code = (await api().get(`${S}/me/referrals`).set(bearer(adv.token))).body.data.code;
    const reg = await api().post(`${S}/auth/register`).send({ name: "Sam Self", email: `${base}+alt@test.dev`, password: "Password123!", referralCode: code });
    expect(reg.status).toBe(201);
    await settle();
    const ref = await prisma.referral.findUniqueOrThrow({ where: { friendCustomerId: reg.body.data.customer.id } });
    expect(ref.status).toBe("rejected");
    expect(ref.fraudScore).toBe(100);
    expect(await prisma.customerCoupon.count({ where: { customerId: reg.body.data.customer.id } })).toBe(0);
    const approve = await api().post(`${A}/referrals/${ref.id}/approve`).set(bearer(admin)).send({});
    expect(approve.status).toBe(409);

    // a genuine friend whose qualifying order is refunded → expired, no reward
    const email = `${uniq("f")}@test.dev`;
    const r2 = await api().post(`${S}/auth/register`).send({ name: "Kemi Ade", email, password: "Password123!", referralCode: code });
    await settle();
    const f = { token: r2.body.data.accessToken, email };
    const { order } = await buy(f, await pickProduct(N(60_000), N(400_000)));
    await api().post(`${A}/orders/${order.id}/refund`).set(bearer(admin)).send({ reason: "Returned", to: "wallet" });
    await settle();
    await referralsService.qualifyDue();
    expect((await prisma.referral.findUniqueOrThrow({ where: { friendCustomerId: r2.body.data.customer.id } })).status).toBe("expired");
  });

  it("admin flags, approves and pauses advocates; config is editable", async () => {
    const adv = await registerCustomer({ name: "Zara Musa" });
    const code = (await api().get(`${S}/me/referrals`).set(bearer(adv.token))).body.data.code;
    const reg = await api().post(`${S}/auth/register`).send({ name: "Bola Ige", email: `${uniq("b")}@test.dev`, password: "Password123!", referralCode: code });
    await settle();
    const ref = await prisma.referral.findUniqueOrThrow({ where: { friendCustomerId: reg.body.data.customer.id } });

    expect((await api().post(`${A}/referrals/${ref.id}/flag`).set(bearer(support)).send({})).status).toBe(403);
    const flag = await api().post(`${A}/referrals/${ref.id}/flag`).set(bearer(marketing)).send({ note: "Same device" });
    expect(flag.body.data.status).toBe("flagged");
    const ok = await api().post(`${A}/referrals/${ref.id}/approve`).set(bearer(marketing)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe("rewarded");

    const cfg = await api().put(`${A}/referrals/config`).set(bearer(marketing)).send({ advocateReward: { type: "points", value: 1000 } });
    expect(cfg.status).toBe(200);
    expect((await api().get(`${A}/referrals/config`).set(bearer(admin))).body.data.advocateReward).toEqual({ type: "points", value: 1000 });
    await api().put(`${A}/referrals/config`).set(bearer(marketing)).send({ advocateReward: { type: "credit", value: N(15_000) } });

    const advRow = await prisma.advocate.findUniqueOrThrow({ where: { code } });
    const pause = await api().patch(`${A}/referrals/advocates/${advRow.id}/status`).set(bearer(marketing)).send({ status: "paused" });
    expect(pause.body.data.status).toBe("paused");
    // paused code is no longer accepted
    expect((await api().post(`${S}/referrals/click/${code}`).send({})).status).toBe(404);
    const late = await api().post(`${S}/auth/register`).send({ name: "Late Friend", email: `${uniq("l")}@test.dev`, password: "Password123!", referralCode: code });
    await settle();
    expect(await prisma.referral.count({ where: { friendCustomerId: late.body.data.customer.id } })).toBe(0);
  });
});

describe("admin club", () => {
  it("adjusts points with marketing.manage only; reads need customers.view; customers list shows the balance", async () => {
    const c = await registerCustomer();
    await settle();
    const denied = await api().post(`${A}/club/points/adjust`).set(bearer(support)).send({ customerId: c.customer.id, delta: 100, reason: "Nice" });
    expect(denied.status).toBe(403);
    const add = await api().post(`${A}/club/points/adjust`).set(bearer(marketing)).send({ customerId: c.customer.id, delta: 400, reason: "Service recovery" });
    expect(add.status).toBe(200);
    expect(add.body.data.points).toBe(SIGNUP + 400);
    const tooMuch = await api().post(`${A}/club/points/adjust`).set(bearer(marketing)).send({ customerId: c.customer.id, delta: -10_000, reason: "Oops" });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_POINTS");
    const minus = await api().post(`${A}/club/points/adjust`).set(bearer(marketing)).send({ customerId: c.customer.id, delta: -50, reason: "Correction" });
    expect(minus.body.data.points).toBe(SIGNUP + 350);
    expect(await prisma.auditEvent.count({ where: { action: "club.points_adjusted", entityId: c.customer.id } })).toBe(2);

    const ledger = await api().get(`${A}/club/ledger`).query({ customerId: c.customer.id }).set(bearer(support));
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.map((e: any) => e.delta)).toEqual([-50, 400, SIGNUP]);
    expect(ledger.body.data[0]).toMatchObject({ reason: "Correction", actor: "Admin marketing" });

    const cust = await api().get(`${A}/customers/${c.customer.id}`).set(bearer(admin));
    expect(cust.body.data.loyaltyPoints).toBe(SIGNUP + 350);
    const rows = await api().get(`${A}/customers`).query({ q: c.email }).set(bearer(admin));
    expect(rows.body.data[0].loyaltyPoints).toBe(SIGNUP + 350);

    const ov = await api().get(`${A}/club`).set(bearer(support));
    expect(ov.status).toBe(200);
    expect(ov.body.data.tiers).toHaveLength(4);
    expect(ov.body.data.kpis.pointsOutstanding).toBeGreaterThan(0);
    expect(ov.body.data.kpis.liability).toBe(ov.body.data.kpis.pointsOutstanding * 500);
  });

  it("edits tiers, rules and the reward catalogue", async () => {
    const t = await api().patch(`${A}/club/tiers/Silver`).set(bearer(marketing)).send({ multiplier: 1.2, perks: ["1.2× points"] });
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ multiplier: 1.2, perks: ["1.2× points"] });
    expect((await api().patch(`${A}/club/tiers/Standard`).set(bearer(marketing)).send({ minSpend: 100 })).status).toBe(400);

    const rules = await api().put(`${A}/club/rules`).set(bearer(marketing)).send({ nairaPerPoint: 200 });
    expect(rules.body.data.nairaPerPoint).toBe(200);
    await api().put(`${A}/club/rules`).set(bearer(marketing)).send({ nairaPerPoint: 100 });

    const bad = await api().post(`${A}/club/rewards`).set(bearer(marketing)).send({ title: "Credit", cost: 10, category: "credit" });
    expect(bad.status).toBe(400);
    const created = await api().post(`${A}/club/rewards`).set(bearer(marketing)).send({ title: "15% Off", description: "Once", cost: 1500, category: "coupon", value: 15, eligibleTiers: ["Gold", "Signature"], stock: 2 });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    const dup = await api().post(`${A}/club/rewards/${id}/duplicate`).set(bearer(marketing));
    expect(dup.body.data).toMatchObject({ title: "15% Off (copy)", active: false });
    const tog = await api().post(`${A}/club/rewards/${dup.body.data.id}/toggle`).set(bearer(marketing));
    expect(tog.body.data.active).toBe(true);
    const order = await api().post(`${A}/club/rewards/reorder`).set(bearer(marketing)).send({ ids: [dup.body.data.id, id] });
    expect(order.body.data.slice(0, 2).map((r: any) => r.id)).toEqual([dup.body.data.id, id]);
    const list = await api().get(`${A}/club/rewards`).query({ category: "coupon" }).set(bearer(support));
    expect(list.body.meta.tabs.coupon).toBeGreaterThanOrEqual(3);
    expect((await api().delete(`${A}/club/rewards/${dup.body.data.id}`).set(bearer(marketing))).status).toBe(200);
    // redeemed rewards can't be deleted
    expect((await api().delete(`${A}/club/rewards/rw_coupon_10`).set(bearer(marketing))).status).toBe(409);
  });
});
