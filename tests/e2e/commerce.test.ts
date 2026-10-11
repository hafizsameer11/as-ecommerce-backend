import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { seedCatalog } from "../../prisma/seed/catalog";
import { ordersService } from "@/modules/commerce/orders/orders.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;

let admin: string;

type Pick = { handle: string; productId: string; variantId: string; size: string | null; color: string | null; price: number };

/** an in-stock product (no drop, not concierge) in a price range, with ≥ minFree units of one variant */
async function pickProduct(min: number, max: number, minFree = 3, skip: string[] = []): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, price: { gte: min, lte: max }, handle: { notIn: skip } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= minFree);
    if (v) return { handle: p.handle, productId: p.id, variantId: v.id, size: v.size, color: v.color, price: v.price ?? p.price };
  }
  throw new Error(`no product between ${min} and ${max}`);
}

const free = async (variantId: string) => {
  const l = await prisma.stockLevel.findMany({ where: { variantId } });
  return { onHand: l.reduce((n, s) => n + s.onHand, 0), reserved: l.reduce((n, s) => n + s.reserved, 0) };
};

const addToBag = (token: string, p: Pick, qty = 1) =>
  api().post(`${S}/cart/items`).set(bearer(token)).send({ productId: p.handle, size: p.size, color: p.color, qty });

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

async function place(token: string, extra: Record<string, unknown> = {}) {
  return api().post(`${S}/checkout/place-order`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send(extra);
}

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  expect(r.status).toBe(200);
  await settle();
}

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 240_000);

describe("bag (guest → account)", () => {
  it("guest adds to bag, gets a token, merges into the account after sign-in", async () => {
    const p = await pickProduct(N(10_000), N(140_000));
    const add = await api().post(`${S}/cart/items`).send({ productId: p.handle, size: p.size, color: p.color, qty: 2 });
    expect(add.status).toBe(201);
    const token = add.body.data.guestToken as string;
    expect(token).toBeTruthy();
    expect(add.body.data.count).toBe(2);
    expect(add.body.data.subtotal).toBe(p.price * 2);

    const bag = await api().get(`${S}/cart`).set("X-Cart-Token", token);
    expect(bag.body.data.items).toHaveLength(1);
    expect(bag.body.data.items[0].issue).toBeNull();

    const c = await registerCustomer();
    const merged = await api().post(`${S}/cart/merge`).set(bearer(c.token)).send({ guestToken: token });
    expect(merged.status).toBe(200);
    expect(merged.body.data.count).toBe(2);
    expect(merged.body.data.guestToken).toBeNull();
    // the guest bag is closed
    expect((await api().get(`${S}/cart`).set("X-Cart-Token", token)).body.data.items).toHaveLength(0);
  });

  it("validates size, caps quantity, refuses more than in stock", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(10_000), N(140_000));
    if (p.size) {
      const r = await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, qty: 1 });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/size/i);
    }
    const stock = await free(p.variantId);
    const tooMany = await addToBag(c.token, p, 10);
    if (stock.onHand - stock.reserved < 10) {
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.error.code).toBe("OUT_OF_STOCK");
    }
    const ok = await addToBag(c.token, p, 1);
    const id = ok.body.data.items[0].id;
    const upd = await api().patch(`${S}/cart/items/${id}`).set(bearer(c.token)).send({ qty: 2 });
    expect(upd.body.data.items[0].qty).toBe(2);
    expect((await api().get(`${S}/cart/summary`).set(bearer(c.token))).body.data.count).toBe(2);
    const del = await api().delete(`${S}/cart/items/${id}`).set(bearer(c.token));
    expect(del.body.data.count).toBe(0);
  });

  it("concierge / price-on-request items can't go in the bag", async () => {
    const c = await registerCustomer();
    const p = await prisma.product.findFirst({ where: { OR: [{ isConcierge: true }, { priceOnRequest: true }] } });
    if (!p) return;
    const r = await api().post(`${S}/cart/items`).set(bearer(c.token)).send({ productId: p.handle, qty: 1 });
    expect(r.status).toBe(400);
  });
});

describe("wishlist + addresses", () => {
  it("toggles, lists and merges the wishlist", async () => {
    const c = await registerCustomer();
    const [a, b] = await prisma.product.findMany({ where: { status: "active" }, take: 2 });
    expect((await api().post(`${S}/wishlist`).set(bearer(c.token)).send({ productId: a.handle })).body.data.saved).toBe(true);
    await api().post(`${S}/wishlist/merge`).set(bearer(c.token)).send({ items: [{ productId: a.handle }, { productId: b.handle }, { productId: "nope" }] });
    const list = await api().get(`${S}/wishlist`).set(bearer(c.token));
    expect(list.body.data.count).toBe(2);
    expect((await api().post(`${S}/wishlist`).set(bearer(c.token)).send({ productId: a.handle })).body.data.saved).toBe(false);
    expect((await api().get(`${S}/wishlist/ids`).set(bearer(c.token))).body.data).toEqual([b.handle]);
  });

  it("keeps exactly one default address per type", async () => {
    const c = await registerCustomer();
    const base = { recipient: "John Doe", phone: "+2348012345678", line1: "12 Admiralty Way", city: "Lagos", state: "Lagos" };
    const a1 = await api().post(`${S}/me/addresses`).set(bearer(c.token)).send(base);
    expect(a1.status).toBe(201);
    expect(a1.body.data.isDefault).toBe(true);
    const a2 = await api().post(`${S}/me/addresses`).set(bearer(c.token)).send({ ...base, label: "Work", line1: "1 Broad St", isDefault: true });
    const list = await api().get(`${S}/me/addresses`).set(bearer(c.token));
    expect(list.body.data.filter((x: any) => x.isDefault).map((x: any) => x.id)).toEqual([a2.body.data.id]);
    await api().delete(`${S}/me/addresses/${a2.body.data.id}`).set(bearer(c.token));
    const after = await api().get(`${S}/me/addresses`).set(bearer(c.token));
    expect(after.body.data[0].isDefault).toBe(true);
    // someone else's address is invisible
    const other = await registerCustomer();
    expect((await api().get(`${S}/me/addresses/${a1.body.data.id}`).set(bearer(other.token))).status).toBe(404);
  });
});

describe("delivery fees (U1: one table everywhere)", () => {
  it("quotes Lagos / Abuja / other states / international and free shipping over ₦150k", async () => {
    const q = (qs: string) => api().get(`${S}/shipping/quote?${qs}`);
    expect((await q("state=Lagos%20State&subtotal=1000000")).body.data.options[0].fee).toBe(N(4_000));
    expect((await q("state=FCT&subtotal=1000000")).body.data.options[0].fee).toBe(N(5_000));
    expect((await q("state=Kano&subtotal=1000000")).body.data.options[0].fee).toBe(N(6_000));
    expect((await q(`state=Kano&subtotal=${N(150_000)}`)).body.data.options[0].fee).toBe(0);
    const intl = await q("country=GB&subtotal=1000000&weightKg=3");
    expect(intl.body.data.options[0].fee).toBe(N(45_000) + 2 * N(8_000));
    const table = await api().get(`${S}/shipping/rates`);
    expect(table.body.data.map((z: any) => z.zone)).toEqual(["Lagos", "Abuja", "Other States", "International"]);
    const pub = await api().get(`${S}/settings/public`);
    expect(pub.body.data.deliveryRates[0].zone).toBe("Lagos");
    expect(pub.body.data.shipping.freeShippingThreshold).toBe(N(150_000));
  });
});

describe("checkout → order → payment", () => {
  it("prefills, prices, applies a coupon and places an order that reserves stock", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    await addToBag(c.token, p, 1);
    const before = await free(p.variantId);

    const ck = await api().get(`${S}/checkout`).set(bearer(c.token));
    expect(ck.status).toBe(200);
    expect(ck.body.data.session.contact.email).toBe(c.email);
    expect(ck.body.data.totals.shipping).toBeNull(); // no address yet → fee unknown
    const upd = await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678", subscribe: false }, delivery: "ship", address: lagos });
    expect(upd.body.data.totals.shipping).toBe(N(4_000));
    expect(upd.body.data.totals.shippingOption.name).toBe("Lagos delivery");
    // VAT is inside the price (7.5 / 107.5)
    const t0 = upd.body.data.totals;
    expect(t0.tax.added).toBe(0);
    expect(t0.tax.included).toBe(Math.round(((t0.subtotal + t0.shipping) * 750) / 10_750));
    expect(t0.total).toBe(p.price + N(4_000));

    const bad = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "NOPE" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("COUPON_INVALID");
    const app = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "app10" });
    expect(app.status).toBe(400); // mobile-only code on web
    const ok = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "asl20off" });
    expect(ok.status).toBe(200);
    const t = ok.body.data.checkout.totals;
    expect(t.discount).toBe(Math.round(p.price * 0.2));
    expect(t.total).toBe(p.price - t.discount + N(4_000));

    const noKey = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).send({});
    expect(noKey.status).toBe(400);

    const key = uniq("idem");
    const r = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", key).send({ expectedTotal: t.total });
    expect(r.status).toBe(201);
    expect(r.body.data.order.number).toMatch(/^ASL-ORD-\d+$/);
    expect(r.body.data.payment.authorizationUrl).toContain("/mock/checkout/");
    // replay → same order, no second order
    const again = await api().post(`${S}/checkout/place-order`).set(bearer(c.token)).set("Idempotency-Key", key).send({ expectedTotal: t.total });
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.body.data.order.id).toBe(r.body.data.order.id);
    expect(await prisma.order.count({ where: { customerId: c.customer.id } })).toBe(1);

    const during = await free(p.variantId);
    expect(during.reserved).toBe(before.reserved + 1);
    expect((await api().get(`${S}/cart`).set(bearer(c.token))).body.data.count).toBe(0);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "ASL20OFF" } })).usedCount).toBe(1);

    await payMock(r.body.data.payment.reference);
    const after = await free(p.variantId);
    expect(after.reserved).toBe(before.reserved);
    expect(after.onHand).toBe(before.onHand - 1);

    const mine = await api().get(`${S}/me/orders/${r.body.data.order.number}`).set(bearer(c.token));
    expect(mine.body.data.status).toBe("Processing");
    expect(mine.body.data.statusKey).toBe("paid");
    expect(mine.body.data.due).toBe(0);
    expect(mine.body.data.timeline.map((e: any) => e.type)).toEqual(["placed", "payment_confirmed"]);
    const list = await api().get(`${S}/me/orders`).set(bearer(c.token));
    expect(list.body.meta.stats.total).toBe(1);
    expect(list.body.data[0].items[0].price).toBe(p.price);

    const stats = await prisma.customerStats.findUniqueOrThrow({ where: { customerId: c.customer.id } });
    expect(stats.ordersCount).toBe(1);
    expect((await api().get(`${S}/payments/${r.body.data.payment.reference}`).set(bearer(c.token))).body.data.status).toBe("succeeded");
  });

  it("refuses when the total changed, and when stock ran out", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, address: lagos });
    const r = await place(c.token, { expectedTotal: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.details.totals.total).toBeGreaterThan(1);
    // someone buys the rest
    const lv = await prisma.stockLevel.findMany({ where: { variantId: p.variantId } });
    for (const l of lv) await prisma.stockLevel.update({ where: { variantId_warehouseId: { variantId: l.variantId, warehouseId: l.warehouseId } }, data: { reserved: l.onHand } });
    const out = await place(c.token);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("OUT_OF_STOCK");
    for (const l of lv) await prisma.stockLevel.update({ where: { variantId_warehouseId: { variantId: l.variantId, warehouseId: l.warehouseId } }, data: { reserved: l.reserved } });
  });

  it("pays fully from the wallet (no payment page) and partly wallet + card", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    await api().post(`${A}/wallets/adjust`).set(bearer(admin)).send({ customerId: c.customer.id, amount: N(500_000), kind: "credit", note: "Test credit" });

    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, address: lagos, paymentMethod: "wallet" });
    const r = await place(c.token);
    expect(r.status).toBe(201);
    expect(r.body.data.payment).toBeNull();
    expect(r.body.data.order.status).toBe("paid");
    const w = await api().get(`${S}/me/wallet`).set(bearer(c.token));
    expect(w.body.data.balance).toBe(N(500_000) - (p.price + N(4_000)));
    expect(w.body.data.recent[0].type).toBe("Debit");

    // partial: drain to ₦10,000, then pay the rest by card
    await api().post(`${A}/wallets/adjust`).set(bearer(admin)).send({ customerId: c.customer.id, amount: -(w.body.data.balance - N(10_000)), note: "Test drain" });
    await addToBag(c.token, p, 1);
    const ck = await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ paymentMethod: "card", useWallet: true });
    expect(ck.body.data.totals.walletApplied).toBe(N(10_000));
    const r2 = await place(c.token);
    expect(r2.body.data.payment.amount).toBe(p.price + N(4_000) - N(10_000));
    await payMock(r2.body.data.payment.reference);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r2.body.data.order.id } });
    expect(o.status).toBe("paid");
    expect(o.amountPaid).toBe(o.total);
  });

  it("failed payment keeps the order open; paying again works; cancel refunds and restocks", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    const start = await free(p.variantId);
    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, address: lagos });
    const r = await place(c.token);
    await payMock(r.body.data.payment.reference, "failed");
    let o = await api().get(`${S}/me/orders/${r.body.data.order.id}`).set(bearer(c.token));
    expect(o.body.data.statusKey).toBe("pending_payment");
    expect(o.body.data.canPay).toBe(true);

    const pay = await api().post(`${S}/me/orders/${r.body.data.order.id}/pay`).set(bearer(c.token)).set("Idempotency-Key", uniq("k")).send({});
    expect(pay.status).toBe(200);
    await payMock(pay.body.data.reference);
    o = await api().get(`${S}/me/orders/${r.body.data.order.id}`).set(bearer(c.token));
    expect(o.body.data.statusKey).toBe("paid");
    expect((await free(p.variantId)).onHand).toBe(start.onHand - 1);

    const cancel = await api().post(`${S}/me/orders/${r.body.data.order.id}/cancel`).set(bearer(c.token)).send({ reason: "Changed my mind" });
    expect(cancel.body.data.statusKey).toBe("cancelled");
    expect(cancel.body.data.amountRefunded).toBe(cancel.body.data.total);
    const back = await free(p.variantId);
    expect(back.onHand).toBe(start.onHand);
    expect(back.reserved).toBe(start.reserved);
    const refunds = await prisma.refund.findMany({ where: { payment: { orderId: r.body.data.order.id } } });
    expect(refunds.reduce((n, x) => n + x.amount, 0)).toBe(cancel.body.data.total);
  });

  it("unpaid orders expire: stock and coupon uses come back", async () => {
    const c = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    const start = await free(p.variantId);
    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, address: lagos });
    await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "ASL20OFF" });
    const used = (await prisma.coupon.findUniqueOrThrow({ where: { code: "ASL20OFF" } })).usedCount;
    const r = await place(c.token);
    expect((await free(p.variantId)).reserved).toBe(start.reserved + 1);
    await prisma.order.update({ where: { id: r.body.data.order.id }, data: { placedAt: new Date(Date.now() - 3 * 3600_000) } });
    await ordersService.expireUnpaid();
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
    expect(o.status).toBe("cancelled");
    expect((await free(p.variantId)).reserved).toBe(start.reserved);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: "ASL20OFF" } })).usedCount).toBe(used);
    // a late payment for the cancelled order is refunded automatically, never kept
    await payMock(r.body.data.payment.reference);
    const late = await prisma.payment.findUniqueOrThrow({ where: { reference: r.body.data.payment.reference } });
    expect(late.status).toBe("refunded");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("cancelled");
  });

  it("guest checkout is off by default (setting)", async () => {
    const p = await pickProduct(N(20_000), N(70_000));
    const add = await api().post(`${S}/cart/items`).send({ productId: p.handle, size: p.size, color: p.color, qty: 1 });
    const r = await api().post(`${S}/checkout/place-order`).set("X-Cart-Token", add.body.data.guestToken).set("Idempotency-Key", uniq("g")).send({});
    expect(r.status).toBe(401);
  });

  it("first-order coupon rules (WELCOME10: new customers, min ₦50k, cap ₦25k)", async () => {
    const c = await registerCustomer();
    const cheap = await pickProduct(N(1_000), N(45_000));
    await addToBag(c.token, cheap, 1);
    const low = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "WELCOME10" });
    if (cheap.price < N(50_000)) expect(low.body.error.code).toBe("COUPON_MIN_SUBTOTAL");
    await api().delete(`${S}/cart`).set(bearer(c.token));
    const big = await pickProduct(N(300_000), N(5_000_000), 1);
    await addToBag(c.token, big, 1);
    const ok = await api().post(`${S}/checkout/coupon`).set(bearer(c.token)).send({ code: "WELCOME10" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.coupon.discount).toBe(N(25_000));
    // FREESHIP auto-applies above ₦150k and stacks? WELCOME10 is not stackable → only one applies
    expect(ok.body.data.checkout.totals.coupons.map((x: any) => x.code)).toEqual(["WELCOME10"]);
  });
});

describe("payment webhooks", () => {
  it("rejects bad signatures and ignores duplicate events", async () => {
    const bad = await api().post(`${W}/mock`).set("x-signature", "nope").send({ id: 1, event: "charge.success", data: { reference: "x" } });
    expect(bad.status).toBe(401);

    const c = await registerCustomer();
    const top = await api().post(`${S}/me/wallet/topup`).set(bearer(c.token)).set("Idempotency-Key", uniq("t")).send({ amount: N(20_000) });
    expect(top.status).toBe(200);
    const ref = top.body.data.reference;
    // the gateway marks it paid, then tells us via webhook (twice)
    const { paymentProvider } = await import("@/providers/payment/payment");
    (paymentProvider as any).settle(ref, "success", N(20_000));
    const body = JSON.stringify({ id: `evt_${ref}`, event: "charge.success", data: { reference: ref } });
    const sig = crypto.createHmac("sha512", "test-webhook-secret").update(body).digest("hex");
    const send = () => api().post(`${W}/mock`).set("x-signature", sig).set("Content-Type", "application/json").send(body);
    expect((await send()).body.data.received).toBe(true);
    expect((await send()).body.data.duplicate).toBe(true);
    await settle();
    const w = await api().get(`${S}/me/wallet`).set(bearer(c.token));
    expect(w.body.data.balance).toBe(N(20_000));
    expect(w.body.data.recent[0].title).toBe("Added to wallet");
    // top-up below the minimum
    expect((await api().post(`${S}/me/wallet/topup`).set(bearer(c.token)).set("Idempotency-Key", uniq("t")).send({ amount: N(100) })).status).toBe(400);
  });
});

describe("wallet withdrawals", () => {
  it("holds the money, then pays out or returns it", async () => {
    const c = await registerCustomer();
    await api().post(`${A}/wallets/adjust`).set(bearer(admin)).send({ customerId: c.customer.id, amount: N(50_000), kind: "credit", note: "Goodwill" });
    const banks = await api().get(`${S}/banks`);
    const acct = await api().post(`${S}/me/bank-accounts`).set(bearer(c.token)).send({ bankCode: banks.body.data[0].code, accountNumber: "0123456789" });
    expect(acct.body.data.accountName).toBe("JOHN DOE");
    const wd = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(20_000), bankAccountId: acct.body.data.id });
    expect(wd.body.data.status).toBe("Pending");
    let w = (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data;
    expect([w.balance, w.held]).toEqual([N(30_000), N(20_000)]);
    const tooMuch = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(40_000), bankAccountId: acct.body.data.id });
    expect(tooMuch.body.error.code).toBe("INSUFFICIENT_WALLET_BALANCE");

    const fail = await api().post(`${A}/wallets/transactions/${wd.body.data.id}/mark-failed`).set(bearer(admin)).send({ reason: "Wrong account" });
    expect(fail.body.data.status).toBe("failed");
    w = (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data;
    expect([w.balance, w.held]).toEqual([N(50_000), 0]);

    const wd2 = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(10_000), bankAccountId: acct.body.data.id });
    await api().post(`${A}/wallets/transactions/${wd2.body.data.id}/approve`).set(bearer(admin));
    w = (await api().get(`${S}/me/wallet`).set(bearer(c.token))).body.data;
    expect([w.balance, w.held]).toEqual([N(40_000), 0]);

    await api().post(`${A}/wallets/${c.customer.id}/freeze`).set(bearer(admin));
    const frozen = await api().post(`${S}/me/wallet/withdraw`).set(bearer(c.token)).set("Idempotency-Key", uniq("w")).send({ amount: N(5_000), bankAccountId: acct.body.data.id });
    expect(frozen.body.error.code).toBe("WALLET_FROZEN");
    const list = await api().get(`${A}/wallets/transactions?customerId=${c.customer.id}`).set(bearer(admin));
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
    expect(list.body.meta.liabilities).toBeGreaterThan(0);
  });
});

describe("admin orders", () => {
  let orderId: string;
  let customer: Awaited<ReturnType<typeof registerCustomer>>;

  beforeAll(async () => {
    customer = await registerCustomer();
    const p = await pickProduct(N(20_000), N(70_000));
    await addToBag(customer.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(customer.token)).send({ contact: { email: customer.email, phone: "+2348012345678" }, address: lagos, paymentMethod: "bank" });
    const r = await place(customer.token);
    orderId = r.body.data.order.id;
  });

  it("lists with tabs and KPIs, confirms a bank transfer, moves through statuses", async () => {
    const list = await api().get(`${A}/orders?tab=awaiting_payment`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.some((o: any) => o.id === orderId)).toBe(true);
    expect(list.body.data[0].statusLabel).toBe("Awaiting payment");
    expect(list.body.meta.tabs.awaiting_payment).toBeGreaterThan(0);

    const skip = await api().patch(`${A}/orders/${orderId}/status`).set(bearer(admin)).send({ status: "shipped" });
    expect(skip.status).toBe(409);
    const paid = await api().post(`${A}/orders/${orderId}/mark-paid`).set(bearer(admin)).send({ reference: "GTB-778812", method: "bank_transfer" });
    expect(paid.body.data.status).toBe("paid");
    expect(paid.body.data.statusLabel).toBe("Unfulfilled");
    for (const s of ["processing", "shipped", "delivered"]) {
      const r = await api().patch(`${A}/orders/${orderId}/status`).set(bearer(admin)).send({ status: s });
      expect(r.body.data.status).toBe(s);
    }
    const mine = await api().get(`${S}/me/orders/${orderId}`).set(bearer(customer.token));
    expect(mine.body.data.status).toBe("Delivered");
    expect(mine.body.data.canReturn).toBe(true);
    expect(mine.body.data.canCancel).toBe(false);
    const audit = await prisma.auditEvent.findMany({ where: { entityId: orderId } });
    expect(audit.length).toBeGreaterThanOrEqual(4);
  });

  it("refunds part to the wallet; support role can't refund", async () => {
    const support = (await createAdmin("support")).token;
    expect((await api().post(`${A}/orders/${orderId}/refund`).set(bearer(support)).send({ amount: N(5_000), reason: "Late delivery", to: "wallet" })).status).toBe(403);
    const r = await api().post(`${A}/orders/${orderId}/refund`).set(bearer(admin)).send({ amount: N(5_000), reason: "Late delivery", to: "wallet" });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("partially_refunded");
    expect(r.body.data.amountRefunded).toBe(N(5_000));
    expect((await api().get(`${S}/me/wallet`).set(bearer(customer.token))).body.data.balance).toBe(N(5_000));
    const tooMuch = await api().post(`${A}/orders/${orderId}/refund`).set(bearer(admin)).send({ amount: N(50_000_000), reason: "x refund", to: "wallet" });
    expect(tooMuch.status).toBe(400);
  });

  it("notes and CSV export", async () => {
    const n = await api().post(`${A}/orders/${orderId}/notes`).set(bearer(admin)).send({ body: "VIP — gift wrap" });
    expect(n.status).toBe(201);
    const d = await api().get(`${A}/orders/${orderId}`).set(bearer(admin));
    expect(d.body.data.notes[0].body).toBe("VIP — gift wrap");
    const csv = await api().get(`${A}/orders/export`).set(bearer(admin));
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.split("\r\n")[0]).toContain("Order,Placed,Customer");
  });
});

describe("admin coupons, zones, tax", () => {
  it("creates, validates, duplicates and pauses coupons", async () => {
    const body = { code: "test15", title: "Test 15", type: "percent", value: 15, status: "active", channels: ["web"] };
    const r = await api().post(`${A}/coupons`).set(bearer(admin)).send(body);
    expect(r.status).toBe(201);
    expect(r.body.data.code).toBe("TEST15");
    expect((await api().post(`${A}/coupons`).set(bearer(admin)).send(body)).status).toBe(409);
    expect((await api().post(`${A}/coupons`).set(bearer(admin)).send({ ...body, code: "BAD", value: 150 })).status).toBe(400);
    const dup = await api().post(`${A}/coupons/${r.body.data.id}/duplicate`).set(bearer(admin));
    expect(dup.body.data.status).toBe("draft");
    await api().patch(`${A}/coupons/${r.body.data.id}/status`).set(bearer(admin)).send({ status: "paused" });
    const list = await api().get(`${A}/coupons?status=paused`).set(bearer(admin));
    expect(list.body.data.some((c: any) => c.code === "TEST15")).toBe(true);
    expect(list.body.meta.tabs.expired).toBeGreaterThanOrEqual(1);
  });

  it("edits a zone fee and checkout uses it immediately", async () => {
    const zones = await api().get(`${A}/shipping-zones`).set(bearer(admin));
    const lagosZone = zones.body.data.find((z: any) => z.name === "Lagos");
    const rate = lagosZone.rates[0];
    await api().put(`${A}/shipping-zones/${lagosZone.id}/rates/${rate.id}`).set(bearer(admin)).send({ ...rate, carrier: "In-house", baseFee: N(4_500) });
    expect((await api().get(`${S}/shipping/quote?state=Lagos`)).body.data.options[0].fee).toBe(N(4_500));
    await api().put(`${A}/shipping-zones/${lagosZone.id}/rates/${rate.id}`).set(bearer(admin)).send({ ...rate, carrier: "InHouse", baseFee: N(4_000) });
  });

  it("tax overview and rate edits", async () => {
    const t = await api().get(`${A}/tax`).set(bearer(admin));
    expect(t.body.data.rates[0]).toMatchObject({ code: "NG-VAT", rate: 7.5, basis: "inclusive" });
    const add = await api().post(`${A}/tax/rates`).set(bearer(admin)).send({ name: "Lagos levy", scope: "state", region: "NG-LA", rate: 1, basis: "exclusive", appliesTo: ["products"], code: "LA-1" });
    expect(add.status).toBe(201);
    const q = await api().get(`${S}/shipping/quote?state=Lagos`);
    expect(q.status).toBe(200);
    await api().delete(`${A}/tax/rates/${add.body.data.id}`).set(bearer(admin));
  });
});
