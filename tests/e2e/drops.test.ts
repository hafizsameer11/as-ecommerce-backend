import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { mail } from "@/providers/mail/mail";
import { seedCatalog } from "../../prisma/seed/catalog";
import { reservationsService } from "@/modules/catalog/drops/reservations.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const HOUR = 3_600_000;

let admin: string;

type Pick = { handle: string; productId: string; variantId: string; size: string | null; price: number };
const used: string[] = [];

/** an in-stock product without a drop, with ≥ minFree units of one variant */
async function pickProduct(minFree = 4): Promise<Pick> {
  const rows = await prisma.product.findMany({
    where: { status: "active", availability: "in_stock", priceOnRequest: false, isConcierge: false, drop: null, handle: { notIn: used } },
    include: { variants: { include: { stock: true } } },
    orderBy: { price: "asc" },
  });
  for (const p of rows) {
    if (p.variants.some((v) => v.color)) continue;
    const v = p.variants.find((x) => x.stock.reduce((n, s) => n + s.onHand - s.reserved, 0) >= minFree);
    if (v) {
      used.push(p.handle);
      return { handle: p.handle, productId: p.id, variantId: v.id, size: v.size, price: v.price ?? p.price };
    }
  }
  throw new Error("no product");
}

const stockOf = async (variantId: string) => {
  const l = await prisma.stockLevel.findMany({ where: { variantId } });
  return { onHand: l.reduce((n, s) => n + s.onHand, 0), reserved: l.reduce((n, s) => n + s.reserved, 0) };
};

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  // 303 = back to the app's returnUrl
  expect([200, 303]).toContain(r.status);
  await settle();
}

async function createDrop(p: Pick, o: { allocation?: number; releaseInHours?: number; depositPct?: number } = {}) {
  const r = await api().post(`${A}/drops`).set(bearer(admin)).send({
    productId: p.handle, releaseAt: new Date(Date.now() + (o.releaseInHours ?? 24 * 7) * HOUR).toISOString(), allocation: o.allocation ?? 5,
    depositPct: o.depositPct, teaser: "Single run only.",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; depositPct: number; allocation: number };
}

const reserve = (token: string, dropId: string, size: string | null) =>
  api().post(`${S}/drops/${dropId}/reserve`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send({ size, returnUrl: "http://localhost:3000/account" });

async function reservePaid(token: string, dropId: string, size: string | null) {
  const r = await reserve(token, dropId, size);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await payMock(r.body.data.payment.reference);
  const me = await api().get(`${S}/me/reservations/${r.body.data.reservation.id}`).set(bearer(token));
  expect(me.body.data.status).toBe("reserved");
  return me.body.data as { id: string; number: string; deposit: number; balance: number; price: number };
}

const entries = (reference: string) => prisma.journalEntry.findMany({ where: { reference }, include: { lines: true } });
const net = (lines: { accountCode: string; debit: bigint; credit: bigint }[], code: string) =>
  lines.filter((l) => l.accountCode === code).reduce((n, l) => n + Number(l.debit) - Number(l.credit), 0);

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 240_000);

describe("drop reservations: reserve → deposit → release → balance → order", () => {
  let p: Pick;
  let dropId: string;
  let a: Awaited<ReturnType<typeof registerCustomer>>;
  let resA: Awaited<ReturnType<typeof reservePaid>>;
  let c: Awaited<ReturnType<typeof registerCustomer>>;
  let resC: Awaited<ReturnType<typeof reservePaid>>;

  it("seeded drops still list publicly", async () => {
    const r = await api().get(`${S}/drops`);
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    const one = await api().get(`${S}/drops/${r.body.data[0].id}`);
    expect(one.body.data.myReservation).toBeNull();
  });

  it("admin creates a drop (deposit % from settings)", async () => {
    p = await pickProduct(4);
    const d = await createDrop(p, { allocation: 2 });
    dropId = d.id;
    expect(d.depositPct).toBe(20);
    expect(d.allocation).toBe(2);
    const dup = await api().post(`${A}/drops`).set(bearer(admin)).send({ productId: p.handle, releaseAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), allocation: 3 });
    expect(dup.status).toBe(409);
  });

  it("reserve → pending deposit → mock payment → reserved, deposit journaled to 2200", async () => {
    a = await registerCustomer();
    const r = await reserve(a.token, dropId, p.size);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const deposit = Math.round(p.price * 0.2);
    expect(r.body.data.reservation).toMatchObject({ status: "pending_deposit", price: p.price, deposit, balance: p.price - deposit, size: p.size, depositPaid: false });
    expect(r.body.data.reservation.number).toMatch(/^RSV-/);
    expect(r.body.data.payment.authorizationUrl).toBeTruthy();
    await payMock(r.body.data.payment.reference);

    const me = await api().get(`${S}/me/reservations/${r.body.data.reservation.number}`).set(bearer(a.token));
    expect(me.body.data).toMatchObject({ status: "reserved", depositPaid: true, balanceDue: p.price - deposit, canCancel: true });
    expect(me.body.data.payBalance.open).toBe(false);
    resA = me.body.data;
    expect((await prisma.drop.findUniqueOrThrow({ where: { id: dropId } })).reservedCount).toBe(1);

    const [je] = await entries(`${resA.number}:deposit`);
    expect(net(je.lines, "1010")).toBe(deposit);
    expect(net(je.lines, "2200")).toBe(-deposit);
    expect(mail.outbox!.some((m) => m.to === a.email && m.subject.includes(resA.number))).toBe(true);

    const list = await api().get(`${S}/me/reservations`).set(bearer(a.token));
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.tabs).toMatchObject({ all: 1, active: 1, past: 0 });
    const drop = await api().get(`${S}/drops/${dropId}`).set(bearer(a.token));
    expect(drop.body.data.myReservation.number).toBe(resA.number);
  });

  it("a second reservation for the same drop is refused", async () => {
    const r = await reserve(a.token, dropId, p.size);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ALREADY_RESERVED");
  });

  it("the allocation counts unpaid deposits until their hold lapses", async () => {
    const b = await registerCustomer();
    const pending = await reserve(b.token, dropId, p.size);
    expect(pending.status).toBe(201);
    c = await registerCustomer();
    const full = await reserve(c.token, dropId, p.size);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("OUT_OF_STOCK");

    // B never pays: the hold runs out → cancelled, place freed
    await prisma.reservation.update({ where: { id: pending.body.data.reservation.id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
    const job = await reservationsService.expireDue();
    expect(job.cancelled).toBe(1);
    const bRes = await api().get(`${S}/me/reservations/${pending.body.data.reservation.id}`).set(bearer(b.token));
    expect(bRes.body.data.status).toBe("cancelled");
    expect((await prisma.payment.findUniqueOrThrow({ where: { reference: pending.body.data.payment.reference } })).status).toBe("abandoned");

    resC = await reservePaid(c.token, dropId, p.size);
    expect((await prisma.drop.findUniqueOrThrow({ where: { id: dropId } })).reservedCount).toBe(2);
  });

  it("paying the balance before the drop is refused", async () => {
    const r = await api().post(`${S}/me/reservations/${resA.id}/pay-balance`).set(bearer(a.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("DROP_NOT_OPEN");
  });

  it("release job: upcoming → live, stock held for every reservation, holders notified", async () => {
    const before = await stockOf(p.variantId);
    await prisma.drop.update({ where: { id: dropId }, data: { releaseAt: new Date(Date.now() - 60_000) } });
    const sent = mail.outbox!.length;
    const r = await reservationsService.releaseDue();
    expect(r.released).toBe(1);
    const d = await prisma.drop.findUniqueOrThrow({ where: { id: dropId } });
    expect(["live", "sold_out"]).toContain(d.status);
    expect((await stockOf(p.variantId)).reserved).toBe(before.reserved + 2);
    const live = mail.outbox!.slice(sent).filter((m) => m.subject.includes("pay your balance"));
    expect(live.map((m) => m.to).sort()).toEqual([a.email, c.email].sort());
    // running again changes nothing
    await reservationsService.releaseDue();
    expect((await stockOf(p.variantId)).reserved).toBe(before.reserved + 2);

    const me = await api().get(`${S}/me/reservations/${resA.id}`).set(bearer(a.token));
    expect(me.body.data.payBalance.open).toBe(true);
    expect(me.body.data.canCancel).toBe(false);
  });

  it("pay balance → a paid order with deposit + balance, stock committed, deposit moved out of 2200", async () => {
    const before = await stockOf(p.variantId);
    const r = await api().post(`${S}/me/reservations/${resA.id}/pay-balance`).set(bearer(a.token)).set("Idempotency-Key", uniq("idem")).send({ returnUrl: "http://localhost:3000/account" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.payment.amount).toBe(resA.balance);
    await payMock(r.body.data.payment.reference);

    const me = await api().get(`${S}/me/reservations/${resA.id}`).set(bearer(a.token));
    expect(me.body.data.status).toBe("balance_paid");
    expect(me.body.data.order.number).toMatch(/^ASL-ORD-/);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: me.body.data.order.id }, include: { items: true, payments: true } });
    expect(o).toMatchObject({ status: "paid", paymentStatus: "paid", channel: "web", subtotal: resA.price, total: resA.price, amountPaid: resA.price, shipping: 0, discount: 0 });
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ variantId: p.variantId, size: p.size, qty: 1, unitPrice: resA.price });
    expect(o.payments.map((x) => x.purpose).sort()).toEqual(["order_balance", "reservation_deposit"]);
    const after = await stockOf(p.variantId);
    expect(after).toEqual({ onHand: before.onHand - 1, reserved: before.reserved - 1 });

    const order = await api().get(`${S}/me/orders/${o.number}`).set(bearer(a.token));
    expect(order.status).toBe(200);

    // ledger: order journal counts the whole price as card money; the applied transfer takes the deposit back out
    const sale = await entries(o.number);
    expect(sale.find((e) => e.source === "order")).toBeTruthy();
    const all = [...(await entries(`${resA.number}:deposit`)), ...(await entries(`${resA.number}:applied`)), ...sale.filter((e) => e.source === "order")];
    const lines = all.flatMap((e) => e.lines);
    expect(net(lines, "2200")).toBe(0);
    expect(net(lines, "1010")).toBe(resA.price);

    // paying again is refused
    const again = await api().post(`${S}/me/reservations/${resA.id}/pay-balance`).set(bearer(a.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(again.status).toBe(409);
  });

  it("unpaid balance after the window → expired, deposit forfeited (default) and journaled to other income", async () => {
    const before = await stockOf(p.variantId);
    await prisma.drop.update({ where: { id: dropId }, data: { releaseAt: new Date(Date.now() - 73 * HOUR) } });
    const r = await reservationsService.expireDue();
    expect(r.expired).toBe(1);
    const me = await api().get(`${S}/me/reservations/${resC.id}`).set(bearer(c.token));
    expect(me.body.data).toMatchObject({ status: "expired", depositOutcome: "forfeited", depositRefunded: 0, balanceDue: 0 });
    expect((await stockOf(p.variantId)).reserved).toBe(before.reserved - 1);
    const [je] = await entries(`${resC.number}:forfeit`);
    expect(net(je.lines, "2200")).toBe(resC.deposit);
    expect(net(je.lines, "4800")).toBe(-resC.deposit);
    expect(mail.outbox!.some((m) => m.to === c.email && m.subject.includes("expired"))).toBe(true);
    // a late balance payment can't revive it
    const late = await api().post(`${S}/me/reservations/${resC.id}/pay-balance`).set(bearer(c.token)).set("Idempotency-Key", uniq("idem")).send({});
    expect(late.status).toBe(409);
  });
});

describe("deposit policy, cancellations and admin", () => {
  it("expired with depositRefundable = true → deposit refunded to the original payment", async () => {
    const set = await api().patch(`${A}/settings/drops`).set(bearer(admin)).send({ depositRefundable: true });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const p = await pickProduct(3);
    const d = await createDrop(p, { depositPct: 30 });
    const cust = await registerCustomer();
    const res = await reservePaid(cust.token, d.id, p.size);
    expect(res.deposit).toBe(Math.round(p.price * 0.3));

    const live = await api().post(`${A}/drops/${d.id}/go-live`).set(bearer(admin));
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.data.release.notified).toBe(1);
    await prisma.drop.update({ where: { id: d.id }, data: { releaseAt: new Date(Date.now() - 80 * HOUR) } });
    await reservationsService.expireDue();

    const me = await api().get(`${S}/me/reservations/${res.id}`).set(bearer(cust.token));
    expect(me.body.data).toMatchObject({ status: "expired", depositOutcome: "refunded_original", depositRefunded: res.deposit });
    const pay = await prisma.payment.findFirstOrThrow({ where: { targetId: res.id, purpose: "reservation_deposit" } });
    expect(pay.status).toBe("refunded");
    const [je] = await entries(`${res.number}:deposit`).then((x) => x.filter((e) => e.source === "refund"));
    expect(net(je.lines, "2200")).toBe(res.deposit);
    expect(net(je.lines, "1010")).toBe(-res.deposit);
    await api().patch(`${A}/settings/drops`).set(bearer(admin)).send({ depositRefundable: false });
  });

  let p3: Pick;
  let drop3: string;

  it("customer cancels before release → deposit back in the ASL Wallet, place freed", async () => {
    p3 = await pickProduct(3);
    drop3 = (await createDrop(p3, { allocation: 3, releaseInHours: 24 * 10 })).id;
    const cust = await registerCustomer();
    const res = await reservePaid(cust.token, drop3, p3.size);
    const r = await api().post(`${S}/me/reservations/${res.id}/cancel`).set(bearer(cust.token)).send({ reason: "Changed my mind" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: "cancelled", depositOutcome: "refunded_wallet", depositRefunded: res.deposit });
    const w = await api().get(`${S}/me/wallet`).set(bearer(cust.token));
    expect(w.body.data.balance).toBe(res.deposit);
    expect((await prisma.drop.findUniqueOrThrow({ where: { id: drop3 } })).reservedCount).toBe(0);
    const [je] = (await entries(`${res.number}:deposit`)).filter((e) => e.source === "refund");
    expect(net(je.lines, "2200")).toBe(res.deposit);
    expect(net(je.lines, "2000")).toBe(-res.deposit);
    // can reserve again afterwards
    const again = await reserve(cust.token, drop3, p3.size);
    expect(again.status).toBe(201);
  });

  it("cancelling inside the cut-off before release is refused", async () => {
    const p = await pickProduct(3);
    const d = await createDrop(p, { releaseInHours: 24 });
    const cust = await registerCustomer();
    const res = await reservePaid(cust.token, d.id, p.size);
    const r = await api().post(`${S}/me/reservations/${res.id}/cancel`).set(bearer(cust.token)).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("INVALID_STATE");
  });

  it("admin: list with KPIs, reservations tabs, cancel with refund, update, end", async () => {
    const cust = await registerCustomer();
    const res = await reservePaid(cust.token, drop3, p3.size);

    const list = await api().get(`${A}/drops`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.meta.kpis).toMatchObject({ forfeited: expect.any(Number), conversionPct: expect.any(Number) });
    expect(list.body.meta.kpis.converted).toBeGreaterThanOrEqual(1);
    expect(list.body.meta.kpis.depositsCollected).toBeGreaterThan(0);
    const row = list.body.data.find((d: { id: string }) => d.id === drop3);
    expect(row.stats.reserved).toBe(1);

    const tabs = await api().get(`${A}/drops/${drop3}/reservations?tab=reserved`).set(bearer(admin));
    expect(tabs.status).toBe(200);
    expect(tabs.body.data.map((r: { number: string }) => r.number)).toEqual([res.number]);
    expect(tabs.body.meta.tabs).toMatchObject({ reserved: 1, cancelled: 1, pending_deposit: 1 });

    const tooSmall = await api().patch(`${A}/drops/${drop3}`).set(bearer(admin)).send({ allocation: 1 });
    expect(tooSmall.status).toBe(400);
    const upd = await api().patch(`${A}/drops/${drop3}`).set(bearer(admin)).send({ allocation: 10, teaser: "Now 10 pieces." });
    expect(upd.status).toBe(200);
    expect(upd.body.data.allocation).toBe(10);

    const cancel = await api().post(`${A}/drops/${drop3}/reservations/${res.number}/cancel`).set(bearer(admin)).send({ reason: "Customer request by phone", refundTo: "original" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: "cancelled", depositOutcome: "refunded_original", depositRefunded: res.deposit });
    const pay = await prisma.payment.findFirstOrThrow({ where: { targetId: res.id, purpose: "reservation_deposit" } });
    expect(pay.status).toBe("refunded");
    const audit = await prisma.auditEvent.findFirst({ where: { action: "reservation.cancelled" } });
    expect(audit).toBeTruthy();

    const ended = await api().post(`${A}/drops/${drop3}/end`).set(bearer(admin));
    expect(ended.status).toBe(200);
    expect(ended.body.data.status).toBe("ended");
    expect(await prisma.reservation.count({ where: { dropId: drop3, status: { in: ["pending_deposit", "reserved"] } } })).toBe(0);

    // catalog.view can read, not write
    const viewer = (await createAdmin("analyst")).token;
    expect((await api().get(`${A}/drops`).set(bearer(viewer))).status).toBe(200);
    expect((await api().post(`${A}/drops/${drop3}/end`).set(bearer(viewer))).status).toBe(403);
  });

  it("every journal balances and 2200 holds exactly the deposits still awaiting a balance", async () => {
    const all = await prisma.journalEntry.findMany({ where: { status: "posted" }, include: { lines: true } });
    for (const e of all) {
      const dr = e.lines.reduce((n, l) => n + Number(l.debit), 0);
      const cr = e.lines.reduce((n, l) => n + Number(l.credit), 0);
      expect(dr, e.description).toBe(cr);
    }
    const held = await prisma.reservation.aggregate({ where: { status: "reserved" }, _sum: { deposit: true } });
    expect(-net(all.flatMap((e) => e.lines), "2200")).toBe(held._sum.deposit ?? 0);
  });
});

