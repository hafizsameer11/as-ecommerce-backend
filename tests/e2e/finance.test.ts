import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer, settle, uniq } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { seedCatalog } from "../../prisma/seed/catalog";
import { payoutsService } from "@/modules/payments/payouts/payouts.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
const W = "/api/v1/webhooks/payments";
const N = (naira: number) => naira * 100;
const DAY = 86_400_000;

let admin: string;
let support: string;
let analyst: string;

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

const addToBag = (token: string, p: Pick, qty = 1) =>
  api().post(`${S}/cart/items`).set(bearer(token)).send({ productId: p.handle, size: p.size, color: p.color, qty });

const lagos = { fullName: "John Doe", address: "12 Admiralty Way", apartment: "", city: "Lekki", state: "Lagos State", postal: "106104", country: "Nigeria" };

const place = (token: string, extra: Record<string, unknown> = {}) =>
  api().post(`${S}/checkout/place-order`).set(bearer(token)).set("Idempotency-Key", uniq("idem")).send(extra);

async function payMock(reference: string, outcome: "success" | "failed" = "success") {
  const r = await api().post(`${W}/mock/checkout/${reference}/complete`).type("form").send({ outcome });
  expect(r.status).toBe(200);
  await settle();
}

/** journal as { accountCode: {debit, credit} } */
async function journal(source: string, reference: string, nth = 0) {
  const entries = await prisma.journalEntry.findMany({ where: { source: source as never, reference }, include: { lines: true }, orderBy: { createdAt: "asc" } });
  const e = entries[nth];
  expect(e, `${source} journal for ${reference}`).toBeTruthy();
  const by: Record<string, { debit: number; credit: number }> = {};
  let debit = 0;
  let credit = 0;
  for (const l of e.lines) {
    by[l.accountCode] ??= { debit: 0, credit: 0 };
    by[l.accountCode].debit += Number(l.debit);
    by[l.accountCode].credit += Number(l.credit);
    debit += Number(l.debit);
    credit += Number(l.credit);
  }
  return { entry: e, by, debit, credit, count: entries.length };
}

async function trialBalance() {
  const r = await api().get(`${A}/ledger/trial-balance`).set(bearer(admin));
  expect(r.status).toBe(200);
  return r.body.data as { rows: { code: string; debit: number; credit: number; balance: number }[]; totals: { debit: number; credit: number; balanced: boolean } };
}

/** customer with a paid card order (Lagos delivery) */
async function paidOrder() {
  const c = await registerCustomer();
  const p = await pickProduct(N(20_000), N(90_000));
  await addToBag(c.token, p, 1);
  await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos });
  const r = await place(c.token);
  expect(r.status).toBe(201);
  await payMock(r.body.data.payment.reference);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
  expect(order.status).toBe("paid");
  return { c, p, order, paymentRef: r.body.data.payment.reference as string };
}

let first: Awaited<ReturnType<typeof paidOrder>>;
let topupRef: string;

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
  support = (await createAdmin("support")).token;
  analyst = (await createAdmin("analyst")).token;
}, 240_000);

describe("automatic journals", () => {
  it("order paid by card → Dr clearing / Cr sales, shipping, VAT (balanced to the kobo) + fee journal", async () => {
    first = await paidOrder();
    const o = first.order;
    const j = await journal("order", o.number);
    expect(j.entry.status).toBe("posted");
    expect(j.debit).toBe(j.credit);
    expect(j.debit).toBe(o.total);
    expect(j.by["1010"].debit).toBe(o.total);
    expect(j.by["2000"]).toBeUndefined();
    expect(j.by["2100"].credit).toBe(o.taxIncluded + o.tax);
    const vatShip = Math.round((o.taxIncluded * o.shipping) / (o.subtotal - o.discount + o.shipping));
    expect(j.by["4100"].credit).toBe(o.shipping - vatShip);
    expect(j.by["4000"].credit).toBe(o.total - o.taxIncluded - o.tax - (o.shipping - vatShip));

    const pay = await prisma.payment.findUniqueOrThrow({ where: { reference: first.paymentRef } });
    expect(pay.fee).toBeGreaterThan(0);
    const fee = await journal("fee", pay.reference);
    expect(fee.by["5100"].debit).toBe(pay.fee);
    expect(fee.by["1010"].credit).toBe(pay.fee);

    // same event twice → still one journal
    const { journalOrderPaid } = await import("@/modules/payments/ledger/ledger.listeners");
    expect(await journalOrderPaid(o.id)).toBeNull();
    expect((await journal("order", o.number)).count).toBe(1);

    // admin list + filters
    const list = await api().get(`${A}/ledger/entries`).query({ source: "order", q: o.number }).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].number).toMatch(/^JE-\d+$/);
    expect(list.body.data[0].totals).toEqual({ debit: o.total, credit: o.total, balanced: true });
    const byAccount = await api().get(`${A}/ledger/entries`).query({ account: "5100" }).set(bearer(admin));
    expect(byAccount.body.data.every((e: any) => e.lines.some((l: any) => l.accountCode === "5100"))).toBe(true);
    const one = await api().get(`${A}/ledger/entries/${list.body.data[0].number}`).set(bearer(admin));
    expect(one.body.data.id).toBe(list.body.data[0].id);
  });

  it("wallet goodwill credit, wallet top-up and a wallet + card order", async () => {
    const c = await registerCustomer();
    const adj = await api().post(`${A}/wallets/adjust`).set(bearer(admin)).send({ customerId: c.customer.id, amount: N(10_000), kind: "credit", note: "Goodwill" });
    expect(adj.status).toBe(200);
    await settle();
    const g = await journal("wallet", adj.body.data.reference);
    expect(g.by["5300"].debit).toBe(N(10_000));
    expect(g.by["2000"].credit).toBe(N(10_000));

    const top = await api().post(`${S}/me/wallet/topup`).set(bearer(c.token)).set("Idempotency-Key", uniq("t")).send({ amount: N(5_000) });
    expect(top.status).toBe(200);
    topupRef = top.body.data.reference;
    await payMock(topupRef);
    const t = await journal("wallet", topupRef);
    expect(t.by["1010"].debit).toBe(N(5_000));
    expect(t.by["2000"].credit).toBe(N(5_000));

    const p = await pickProduct(N(20_000), N(90_000));
    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, address: lagos, paymentMethod: "card", useWallet: true });
    const r = await place(c.token);
    await payMock(r.body.data.payment.reference);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r.body.data.order.id } });
    expect(o.walletApplied).toBe(N(15_000));
    const j = await journal("order", o.number);
    expect(j.by["2000"].debit).toBe(N(15_000));
    expect(j.by["1010"].debit).toBe(o.total - N(15_000));
    expect(j.credit).toBe(o.total);
    expect(j.debit).toBe(j.credit);
  });

  it("refunds reverse revenue + VAT proportionally: card part → clearing, wallet part → wallet liability", async () => {
    const o = first.order;
    const half = Math.round(o.total / 2);
    const r1 = await api().post(`${A}/orders/${o.id}/refund`).set(bearer(admin)).send({ amount: half, reason: "Partial refund", to: "original" });
    expect(r1.status).toBe(200);
    await settle();
    const j1 = await journal("refund", o.number);
    expect(j1.by["1010"].credit).toBe(half);
    expect(j1.debit).toBe(half);
    expect(j1.credit).toBe(half);
    const sale = await journal("order", o.number);
    expect(Math.abs(j1.by["2100"].debit - Math.round((half * sale.by["2100"].credit) / o.total))).toBeLessThanOrEqual(1);
    expect(j1.by["4000"].debit).toBeGreaterThan(0);

    const rest = o.total - half;
    const r2 = await api().post(`${A}/orders/${o.id}/refund`).set(bearer(admin)).send({ reason: "Rest to wallet", to: "wallet" });
    expect(r2.status).toBe(200);
    await settle();
    const j2 = await journal("refund", o.number, 1);
    expect(j2.count).toBe(2);
    expect(j2.by["2000"].credit).toBe(rest);
    expect(j2.by["1010"]).toBeUndefined();
    expect(j2.debit).toBe(rest);

    // sales, shipping and VAT for this order are now fully reversed
    const all = await prisma.journalLine.groupBy({
      by: ["accountCode"], where: { entry: { reference: o.number, source: { in: ["order", "refund"] }, status: "posted" } }, _sum: { debit: true, credit: true },
    });
    for (const code of ["4000", "4100", "2100"]) {
      const s = all.find((a) => a.accountCode === code);
      if (s) expect(Number(s._sum.debit)).toBe(Number(s._sum.credit));
    }
  });

  it("cancelling a paid order books the refund; cancelling an unpaid one books nothing", async () => {
    const { c, order } = await paidOrder();
    const cancel = await api().post(`${S}/me/orders/${order.id}/cancel`).set(bearer(c.token)).send({ reason: "Changed my mind" });
    expect(cancel.status).toBe(200);
    await settle();
    const j = await journal("refund", order.number);
    expect(j.by["1010"].credit).toBe(order.total);
    expect(j.debit).toBe(order.total);

    const p = await pickProduct(N(20_000), N(90_000));
    await addToBag(c.token, p, 1);
    await api().patch(`${S}/checkout`).set(bearer(c.token)).send({ contact: { email: c.email, phone: "+2348012345678" }, delivery: "ship", address: lagos });
    const r = await place(c.token);
    expect(r.status).toBe(201);
    await api().post(`${S}/me/orders/${r.body.data.order.id}/cancel`).set(bearer(c.token)).send({ reason: "Unpaid" });
    await settle();
    expect(await prisma.journalEntry.count({ where: { reference: r.body.data.order.number } })).toBe(0);
  });
});

describe("manual journals + trial balance", () => {
  it("rejects unbalanced and two-sided lines, drafts don't count, posting and voiding move the trial balance", async () => {
    const tb0 = await trialBalance();
    expect(tb0.totals.balanced).toBe(true);
    const bal = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.rows.find((r) => r.code === code)?.balance ?? 0;

    const unbalanced = await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({
      description: "Meta Ads", lines: [{ accountCode: "5300", debit: N(4_800) }, { accountCode: "1000", credit: N(4_000) }],
    });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error.details.difference).toBe(N(800));
    const twoSided = await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({
      description: "Bad", lines: [{ accountCode: "5300", debit: 100, credit: 100 }, { accountCode: "1000", credit: 0 }],
    });
    expect(twoSided.status).toBe(400);
    const unknown = await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({
      description: "Bad", lines: [{ accountCode: "9999", debit: 100 }, { accountCode: "1000", credit: 100 }],
    });
    expect(unknown.status).toBe(400);

    const draft = await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({
      description: "Meta Ads · August", reference: "MKTG-AUG", status: "draft",
      lines: [{ accountCode: "5300", debit: N(4_000) }, { accountCode: "1000", credit: N(4_000), memo: "GTBank" }],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe("draft");
    expect(draft.body.data.source).toBe("manual");
    expect(bal(await trialBalance(), "5300")).toBe(bal(tb0, "5300"));

    const fixed = await api().patch(`${A}/ledger/entries/${draft.body.data.id}`).set(bearer(admin)).send({
      lines: [{ accountCode: "5300", debit: N(4_800) }, { accountCode: "1000", credit: N(4_800) }],
    });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.totals.debit).toBe(N(4_800));

    const posted = await api().post(`${A}/ledger/entries/${draft.body.data.id}/post`).set(bearer(admin));
    expect(posted.body.data.status).toBe("posted");
    const tb1 = await trialBalance();
    expect(bal(tb1, "5300")).toBe(bal(tb0, "5300") + N(4_800));
    expect(bal(tb1, "1000")).toBe(bal(tb0, "1000") - N(4_800));
    expect(tb1.totals.balanced).toBe(true);
    expect((await api().patch(`${A}/ledger/entries/${draft.body.data.id}`).set(bearer(admin)).send({ description: "Nope" })).status).toBe(409);

    const voided = await api().post(`${A}/ledger/entries/${draft.body.data.id}/void`).set(bearer(admin));
    expect(voided.body.data.status).toBe("void");
    expect(bal(await trialBalance(), "5300")).toBe(bal(tb0, "5300"));
    expect((await api().post(`${A}/ledger/entries/${draft.body.data.id}/void`).set(bearer(admin))).status).toBe(409);

    const csv = await api().get(`${A}/ledger/entries/export`).query({ q: "MKTG-AUG" }).set(bearer(admin));
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("MKTG-AUG");
  });

  it("accounts: add, archive (no postings), unarchive; balances signed by normal side", async () => {
    const add = await api().post(`${A}/ledger/accounts`).set(bearer(admin)).send({ code: "5400", name: "Bank charges", type: "expense" });
    expect(add.status).toBe(201);
    expect((await api().post(`${A}/ledger/accounts`).set(bearer(admin)).send({ code: "5400", name: "Dup", type: "expense" })).status).toBe(409);
    await api().post(`${A}/ledger/accounts/5400/archive`).set(bearer(admin));
    const blocked = await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({ description: "Charge", lines: [{ accountCode: "5400", debit: 100 }, { accountCode: "1000", credit: 100 }] });
    expect(blocked.status).toBe(400);
    await api().post(`${A}/ledger/accounts/5400/unarchive`).set(bearer(admin));
    expect((await api().post(`${A}/ledger/entries`).set(bearer(admin)).send({ description: "Charge", lines: [{ accountCode: "5400", debit: 100 }, { accountCode: "1000", credit: 100 }] })).status).toBe(201);

    const accts = await api().get(`${A}/ledger/accounts`).set(bearer(admin));
    const a5400 = accts.body.data.find((a: any) => a.code === "5400");
    expect(a5400).toMatchObject({ debit: 100, credit: 0, balance: 100, normal: "debit" });
    const a2000 = accts.body.data.find((a: any) => a.code === "2000");
    expect(a2000.balance).toBe(a2000.credit - a2000.debit);
  });
});

describe("payouts", () => {
  it("sync builds one payout per capture day from yesterday's payments; mark-paid books the bank journal", async () => {
    const yesterday = new Date(Date.now() - DAY);
    const refs = [first.paymentRef, topupRef];
    await prisma.payment.updateMany({ where: { reference: { in: refs } }, data: { paidAt: yesterday } });
    const pays = await prisma.payment.findMany({ where: { reference: { in: refs } }, include: { refunds: true } });

    const r = await api().post(`${A}/payouts/sync`).set(bearer(admin));
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(1);
    const po = r.body.data.payouts[0];
    expect(po.number).toMatch(/^PO-\d+$/);
    expect(po.status).toBe("scheduled");
    expect(po.txnCount).toBe(2);
    const gross = pays.reduce((n, p) => n + p.amount, 0);
    const fees = pays.reduce((n, p) => n + p.fee, 0);
    const refunds = pays.reduce((n, p) => n + p.refunds.reduce((m, x) => m + x.amount, 0), 0);
    expect(refunds).toBeGreaterThan(0); // the half refund to card
    expect(po).toMatchObject({ gross, fees, refunds, net: gross - fees - refunds, bankName: "GTBank", bankAccountMasked: "****4021" });

    // today's payments are not due yet; nothing is synced twice
    expect((await payoutsService.sync()).created).toBe(0);

    const detail = await api().get(`${A}/payouts/${po.id}`).set(bearer(admin));
    expect(detail.body.data.transactions.map((t: any) => t.paymentRef).sort()).toEqual([...refs].sort());
    expect(detail.body.data.transactions.find((t: any) => t.paymentRef === first.paymentRef).orderNumber).toBe(first.order.number);

    const list = await api().get(`${A}/payouts`).set(bearer(admin));
    expect(list.body.meta.tabs.scheduled).toBe(1);
    expect(list.body.meta.kpis.nextPayout.number).toBe(po.number);
    expect(list.body.meta.kpis.pending).toBe(po.net);

    const paid = await api().post(`${A}/payouts/${po.id}/mark-paid`).set(bearer(admin));
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe("paid");
    await settle();
    const j = await journal("payout", po.number);
    expect(j.by["1000"].debit).toBe(po.net);
    expect(j.by["1010"].credit).toBe(po.net);
    expect((await api().post(`${A}/payouts/${po.id}/mark-paid`).set(bearer(admin))).status).toBe(409);
    expect((await api().get(`${A}/payouts`).set(bearer(admin))).body.meta.kpis.paidLast30d).toBe(po.net);
    expect((await api().delete(`${A}/payouts/${po.id}`).set(bearer(admin))).status).toBe(409);
  });

  it("manual payout: hold → release → fail → retry → delete, and CSV export", async () => {
    const c = await api().post(`${A}/payouts`).set(bearer(admin)).send({ provider: "Stripe", gross: N(100_000), fees: N(2_000), refunds: N(1_000), adjustments: -N(500), scheduledAt: new Date(Date.now() + DAY).toISOString(), notes: "Milan batch" });
    expect(c.status).toBe(201);
    const id = c.body.data.id;
    expect(c.body.data.net).toBe(N(100_000) - N(2_000) - N(1_000) - N(500));
    expect((await api().post(`${A}/payouts/${id}/hold`).set(bearer(admin)).send({ note: "Refund spike" })).body.data.status).toBe("on_hold");
    expect((await api().post(`${A}/payouts/${id}/mark-paid`).set(bearer(admin))).status).toBe(409);
    expect((await api().post(`${A}/payouts/${id}/release`).set(bearer(admin))).body.data.status).toBe("scheduled");
    const failed = await api().post(`${A}/payouts/${id}/mark-failed`).set(bearer(admin)).send({ reason: "Account name mismatch" });
    expect(failed.body.data).toMatchObject({ status: "failed", failureReason: "Account name mismatch" });
    const retried = await api().post(`${A}/payouts/${id}/retry`).set(bearer(admin));
    expect(retried.body.data).toMatchObject({ status: "scheduled", failureReason: null });
    const upd = await api().patch(`${A}/payouts/${id}`).set(bearer(admin)).send({ notes: "Updated" });
    expect(upd.body.data.notes).toBe("Updated");
    const csv = await api().get(`${A}/payouts/export`).set(bearer(admin));
    expect(csv.text).toContain(c.body.data.number);
    expect((await api().delete(`${A}/payouts/${id}`).set(bearer(admin))).status).toBe(200);
    expect((await api().get(`${A}/payouts/${id}`).set(bearer(admin))).status).toBe(404);
  });
});

describe("books + permissions", () => {
  it("trial balance balances and the wallet liability equals all customer wallet balances", async () => {
    const tb = await trialBalance();
    expect(tb.totals.balanced).toBe(true);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const wallets = await prisma.wallet.aggregate({ _sum: { balance: true, held: true } });
    expect(tb.rows.find((r) => r.code === "2000")!.balance).toBe((wallets._sum.balance ?? 0) + (wallets._sum.held ?? 0));
  });

  it("support gets 403; finance.view can read but not write", async () => {
    for (const path of ["/ledger/entries", "/ledger/accounts", "/ledger/trial-balance", "/payouts"])
      expect((await api().get(`${A}${path}`).set(bearer(support))).status).toBe(403);
    expect((await api().post(`${A}/payouts/sync`).set(bearer(support))).status).toBe(403);
    expect((await api().get(`${A}/ledger/entries`).set(bearer(analyst))).status).toBe(200);
    expect((await api().get(`${A}/payouts`).set(bearer(analyst))).status).toBe(200);
    const w = await api().post(`${A}/ledger/entries`).set(bearer(analyst)).send({ description: "x", lines: [{ accountCode: "5300", debit: 1 }, { accountCode: "1000", credit: 1 }] });
    expect(w.status).toBe(403);
  });
});
