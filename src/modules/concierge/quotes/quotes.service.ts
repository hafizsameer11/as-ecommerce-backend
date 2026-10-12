/**
 * Concierge quotes + payment.
 *   staff "Send quote" → request `quoted` → customer accepts (delivery address) → payment for the deposit
 *   → paid: 100 % deposit = request `ordered`; otherwise `approved` with the balance due (pay-balance) → `ordered`.
 * Money: every payment is held in 2200 Customer deposits (Dr 1010 / Cr 2200) until the request is delivered,
 * then moved to revenue (Dr 2200 / Cr 4200 service fee, 4100 shipping, 2100 VAT, 4000 item sales).
 */
import type { ConciergeQuote, Payment, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { defineJob } from "@/core/queue/queue";
import { logger } from "@/core/utils/logger";
import { toCsv } from "@/core/utils/csv";
import { formatNaira } from "@/core/utils/money";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { taxService } from "@/modules/fulfilment/tax/tax.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";
import { addTimeline, applyStatus, notifyStaff, requestKey, systemMessage } from "../concierge.common";
import { effectiveStatus, toQuote, type QuoteRow } from "./quotes.mapper";
import type { AcceptBody, AdminQuotesQuery, CreateQuoteBody, DeclineBody, PayBalanceBody, QuoteLineInput, ReviseQuoteBody } from "./quotes.schemas";

const HOUR = 3_600_000;
export const QUOTE_TARGET = "concierge_quote";
const ACC = { bank: "1000", clearing: "1010", vat: "2100", deposits: "2200", sales: "4000", shipping: "4100", fees: "4200" } as const;

const reqSelect = { id: true, number: true, status: true, customerId: true, contactEmail: true, contactName: true, itemName: true, brand: true, supplierId: true, assigneeId: true, deliveryAddress: true } as const;

async function lockQuote(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`ConciergeQuote\` WHERE id = ${id} FOR UPDATE`;
  return tx.conciergeQuote.findUnique({ where: { id }, include: { lines: true, request: { select: reqSelect } } });
}
async function lockRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`ConciergeRequest\` WHERE id = ${id} FOR UPDATE`;
  return tx.conciergeRequest.findUniqueOrThrow({ where: { id }, include: { quotes: { orderBy: { createdAt: "desc" }, include: { lines: true } } } });
}

const normCountry = (c?: string | null) => (!c || /^(ng|nga|nigeria)$/i.test(c.trim()) ? "NG" : c.trim().toUpperCase().slice(0, 2));

/** lines + fees → totals (tax from Admin → Tax; deposit rounded to the kobo, the last kobo goes to the balance) */
async function totals(input: { lines: QuoteLineInput[]; serviceFee: number; shippingEstimate: number; depositPct: number; address?: unknown; email?: string }) {
  const itemsTotal = input.lines.reduce((n, l) => n + l.price * l.qty, 0);
  const addr = (input.address ?? {}) as { country?: string; state?: string; postal?: string };
  const tax = await taxService.compute({
    country: normCountry(addr.country), state: addr.state, postcode: addr.postal,
    productsAmount: itemsTotal, shippingAmount: input.shippingEstimate, conciergeFee: input.serviceFee, customerEmail: input.email,
  });
  const total = itemsTotal + input.serviceFee + input.shippingEstimate + tax.added;
  const deposit = input.depositPct >= 100 ? total : Math.round((total * input.depositPct) / 100);
  return { itemsTotal, tax: tax.added, taxIncluded: tax.included, total, deposit };
}

const lineData = (lines: QuoteLineInput[]) => lines.map((l) => ({ name: l.name, source: l.source ?? null, qty: l.qty, price: l.price }));

async function ownedRequest(customerId: string, id: string) {
  const r = await prisma.conciergeRequest.findFirst({ where: { customerId, ...requestKey(id) }, include: { quotes: { orderBy: { createdAt: "desc" }, include: { lines: true } } } });
  if (!r) throw ApiError.notFound("Request");
  return r;
}

/** close one quote that ran past expiresAt (job + lazily when the customer tries to accept) */
async function expireQuote(quoteId: string, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const q = await lockQuote(tx, quoteId);
    if (!q || !["sent", "accepted"].includes(q.status) || q.amountPaid > 0 || q.expiresAt > now) return false;
    await tx.conciergeQuote.update({ where: { id: q.id }, data: { status: "expired" } });
    await addTimeline(tx, q.requestId, "quote", `Quote ${q.number} expired.`, "System");
    if (["quoted", "payment_pending"].includes(q.request.status)) {
      await tx.conciergeRequest.update({ where: { id: q.requestId }, data: { status: "sourcing" } });
      await systemMessage(tx, q.requestId, `Quote ${q.number} has expired. Message us if you'd like an updated price.`, q.id);
    }
    return true;
  });
}

async function resolveAddress(customerId: string, b: AcceptBody, current: unknown) {
  if (b.addressId) {
    const a = await prisma.address.findFirst({ where: { id: b.addressId, customerId } });
    if (!a) throw ApiError.notFound("Address");
    return { fullName: a.recipient, phone: a.phone, address: a.line1, apartment: a.line2 ?? "", city: a.city, state: a.state, postal: a.postalCode ?? "", country: a.country };
  }
  if (b.address) return b.address;
  if (current) return current;
  const d = await prisma.address.findFirst({ where: { customerId, type: "shipping" }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
  if (d) return { fullName: d.recipient, phone: d.phone, address: d.line1, apartment: d.line2 ?? "", city: d.city, state: d.state, postal: d.postalCode ?? "", country: d.country };
  throw ApiError.badRequest("VALIDATION_FAILED", "Where should we deliver? Add a delivery address.", [{ in: "body", path: "address", message: "Required" }]);
}

/** stop waiting for earlier checkout attempts on this quote (a late capture is still settled — and refunded if not needed) */
async function abandonPending(tx: Tx, quoteId: string) {
  await tx.payment.updateMany({ where: { targetType: QUOTE_TARGET, targetId: quoteId, status: "pending" }, data: { status: "abandoned" } });
}

/** Dr cash / Cr 2200 for what we kept from a concierge payment */
async function journalDeposit(paymentId: string) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) return;
  const kept = p.amount - p.amountRefunded;
  if (kept <= 0) return;
  const q = p.targetId ? await prisma.conciergeQuote.findUnique({ where: { id: p.targetId }, select: { number: true, request: { select: { number: true } } } }) : null;
  await ledgerService.postOnce("order", p.reference, {
    date: p.paidAt ?? new Date(),
    description: `Concierge payment · ${q?.request.number ?? ""} ${q?.number ?? ""}`.trim(),
    createdBy: SYSTEM_USER,
    lines: [
      { accountCode: p.provider === "manual" ? ACC.bank : ACC.clearing, debit: kept, credit: 0, memo: p.provider },
      { accountCode: ACC.deposits, debit: 0, credit: kept, memo: "Customer deposit (concierge)" },
    ],
  });
}

export const quotesService = {
  // ── admin ──
  async create(requestId: string, b: CreateQuoteBody, admin: { id: string; name: string }) {
    const cfg = await settingsService.get("concierge");
    const r0 = await prisma.conciergeRequest.findFirst({ where: requestKey(requestId), select: { id: true } });
    if (!r0) throw ApiError.notFound("Request");
    const quote = await prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, r0.id);
      if (!["new", "sourcing", "quoted", "payment_pending", "unavailable"].includes(r.status))
        throw ApiError.conflict("INVALID_STATE", `A request that is ${r.status.replace("_", " ")} can't get a new quote.`);
      if (r.quotes.some((q) => q.amountPaid > 0)) throw ApiError.conflict("INVALID_STATE", "This request has already been paid.");
      const serviceFee = b.serviceFee ?? cfg.serviceFee;
      const shippingEstimate = b.shippingEstimate ?? cfg.shippingEstimate;
      const depositPct = b.depositPct ?? cfg.defaultDepositPct;
      const t = await totals({ lines: b.lines, serviceFee, shippingEstimate, depositPct, address: r.deliveryAddress, email: r.contactEmail });
      // one live quote per request: earlier unpaid ones are superseded
      const superseded = r.quotes.filter((q) => ["sent", "accepted"].includes(q.status));
      if (superseded.length) {
        await tx.conciergeQuote.updateMany({ where: { id: { in: superseded.map((q) => q.id) } }, data: { status: "expired" } });
        for (const q of superseded) await abandonPending(tx, q.id);
      }
      const number = formatters.quote(await nextSequence(tx, "concierge_quote", 10001));
      const q = await tx.conciergeQuote.create({
        data: {
          number, requestId: r.id, ...t, serviceFee, shippingEstimate, depositPct, note: b.note ?? null, createdBy: admin.name,
          expiresAt: new Date(Date.now() + (b.validityHours ?? cfg.quoteValidityHours) * HOUR),
          lines: { create: lineData(b.lines) },
        },
        include: { lines: true },
      });
      await tx.conciergeRequest.update({ where: { id: r.id }, data: { status: "quoted", ...(r.assigneeId ? {} : { assigneeId: admin.id }) } });
      const dep = depositPct < 100 ? ` · ${depositPct}% deposit ${formatNaira(t.deposit)}` : "";
      await addTimeline(tx, r.id, "quote", `Quote ${number} sent: ${formatNaira(t.total)}${dep}.`, admin.name);
      await systemMessage(tx, r.id, `Your quote ${number} is ready: ${formatNaira(t.total)}${dep}. Valid until ${q.expiresAt.toUTCString()}.`, q.id);
      return q;
    });
    events.emit("concierge.quoted", { quoteId: quote.id });
    return toQuote(quote);
  },

  /** edit a quote the customer hasn't paid yet: totals recomputed, validity restarts, customer notified again */
  async revise(quoteId: string, b: ReviseQuoteBody, admin: { name: string }) {
    const cfg = await settingsService.get("concierge");
    const quote = await prisma.$transaction(async (tx) => {
      const q = await lockQuote(tx, quoteId);
      if (!q) throw ApiError.notFound("Quote");
      if (!["sent", "accepted", "expired"].includes(q.status) || q.amountPaid > 0)
        throw ApiError.conflict("INVALID_STATE", `Quote ${q.number} is ${q.status} and can't be changed.`);
      if (q.status === "expired") {
        const newer = await tx.conciergeQuote.findFirst({ where: { requestId: q.requestId, createdAt: { gt: q.createdAt } }, select: { id: true } });
        if (newer || !["quoted", "sourcing", "payment_pending"].includes(q.request.status)) throw ApiError.conflict("INVALID_STATE", "Send a new quote instead.");
      }
      const lines = b.lines ?? q.lines.map((l) => ({ name: l.name, source: l.source ?? undefined, qty: l.qty, price: l.price }));
      const serviceFee = b.serviceFee ?? q.serviceFee;
      const shippingEstimate = b.shippingEstimate ?? q.shippingEstimate;
      const depositPct = b.depositPct ?? q.depositPct;
      const t = await totals({ lines, serviceFee, shippingEstimate, depositPct, address: q.request.deliveryAddress, email: q.request.contactEmail });
      if (b.lines) {
        await tx.conciergeQuoteLine.deleteMany({ where: { quoteId: q.id } });
        await tx.conciergeQuoteLine.createMany({ data: lineData(b.lines).map((l) => ({ ...l, quoteId: q.id })) });
      }
      await abandonPending(tx, q.id);
      const updated = await tx.conciergeQuote.update({
        where: { id: q.id },
        data: {
          ...t, serviceFee, shippingEstimate, depositPct, status: "sent", acceptedAt: null,
          ...(b.note !== undefined ? { note: b.note || null } : {}),
          expiresAt: new Date(Date.now() + (b.validityHours ?? cfg.quoteValidityHours) * HOUR),
        },
        include: { lines: true },
      });
      if (q.request.status !== "quoted") await tx.conciergeRequest.update({ where: { id: q.requestId }, data: { status: "quoted" } });
      await addTimeline(tx, q.requestId, "quote", `Quote ${q.number} updated: ${formatNaira(t.total)}.`, admin.name);
      await systemMessage(tx, q.requestId, `Your quote ${q.number} was updated: ${formatNaira(t.total)}. Valid until ${updated.expiresAt.toUTCString()}.`, q.id);
      return updated;
    });
    events.emit("concierge.quoted", { quoteId: quote.id });
    return toQuote(quote);
  },

  /** take a quote back (wrong price, item gone): request returns to sourcing */
  async withdraw(quoteId: string, reason: string | undefined, admin: { name: string }) {
    const quote = await prisma.$transaction(async (tx) => {
      const q = await lockQuote(tx, quoteId);
      if (!q) throw ApiError.notFound("Quote");
      if (!["sent", "accepted"].includes(q.status) || q.amountPaid > 0) throw ApiError.conflict("INVALID_STATE", `Quote ${q.number} is ${q.status} and can't be withdrawn.`);
      await abandonPending(tx, q.id);
      const updated = await tx.conciergeQuote.update({ where: { id: q.id }, data: { status: "expired" }, include: { lines: true } });
      await addTimeline(tx, q.requestId, "quote", `Quote ${q.number} withdrawn${reason ? `: ${reason}` : ""}.`, admin.name);
      if (["quoted", "payment_pending"].includes(q.request.status)) {
        await tx.conciergeRequest.update({ where: { id: q.requestId }, data: { status: "sourcing" } });
        await systemMessage(tx, q.requestId, `Quote ${q.number} was withdrawn${reason ? `: ${reason}` : ""}. We'll send you an updated option.`, q.id);
      }
      return updated;
    });
    return toQuote(quote);
  },

  async adminGet(quoteId: string) {
    const q = await prisma.conciergeQuote.findFirst({ where: { OR: [{ id: quoteId }, { number: quoteId.toUpperCase() }] }, include: { lines: true, request: { select: reqSelect } } });
    if (!q) throw ApiError.notFound("Quote");
    return { ...toQuote(q), request: { id: q.request.id, number: q.request.number, itemName: q.request.itemName, brand: q.request.brand, status: q.request.status, customer: q.request.contactName } };
  },

  async adminList(q: AdminQuotesQuery) {
    const now = new Date();
    const live = { amountPaid: 0, status: { in: ["sent", "accepted"] as ConciergeQuote["status"][] } };
    const tab = (t: AdminQuotesQuery["tab"]): Prisma.ConciergeQuoteWhereInput => {
      switch (t) {
        case "pending": return { status: "sent", expiresAt: { gt: now } };
        case "accepted": return { status: "accepted", expiresAt: { gt: now } };
        case "expired": return { OR: [{ status: "expired" }, { ...live, expiresAt: { lte: now } }] };
        case "paid": return { status: "paid" };
        case "declined": return { status: "declined" };
        default: return {};
      }
    };
    const base: Prisma.ConciergeQuoteWhereInput = {
      ...(q.requestId ? { requestId: q.requestId } : {}),
      ...(q.q ? { OR: [{ number: { contains: q.q } }, { request: { OR: [{ number: { contains: q.q } }, { itemName: { contains: q.q } }, { brand: { contains: q.q } }, { contactName: { contains: q.q } }, { contactEmail: { contains: q.q } }] } }] } : {}),
    };
    const where = { AND: [base, tab(q.tab)] };
    const include = { lines: true, request: { select: reqSelect } } as const;
    const [rows, total, counts, sums] = await Promise.all([
      prisma.conciergeQuote.findMany({ where, include, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.conciergeQuote.count({ where }),
      Promise.all((["all", "pending", "accepted", "paid", "expired", "declined"] as const).map(async (t) => [t, await prisma.conciergeQuote.count({ where: { AND: [base, tab(t)] } })] as const)),
      Promise.all((["pending", "accepted", "paid"] as const).map(async (t) => [t, (await prisma.conciergeQuote.aggregate({ where: { AND: [base, tab(t)] }, _sum: { total: true } }))._sum.total ?? 0] as const)),
    ]);
    const c = Object.fromEntries(counts) as Record<(typeof counts)[number][0], number>;
    const s = Object.fromEntries(sums) as Record<"pending" | "accepted" | "paid", number>;
    const decided = c.paid + c.declined + c.expired;
    return withMeta(rows.map(adminRow), {
      ...pageMeta(q, total),
      tabs: c,
      kpis: { outstanding: s.pending + s.accepted, won: s.paid, acceptRate: decided ? Math.round((c.paid / decided) * 100) : 0, avgQuote: total ? Math.round(rows.reduce((n, r) => n + r.total, 0) / rows.length) : 0 },
    });
  },

  async exportCsv(q: AdminQuotesQuery) {
    const all = await this.adminList({ ...q, page: 1, pageSize: 200 });
    const rows = all.data.map((r) => ({
      number: r.number, request: r.request.number, customer: r.request.customer, item: r.request.itemName, brand: r.request.brand ?? "",
      status: r.status, total: r.total / 100, deposit: r.deposit / 100, amountPaid: r.amountPaid / 100, expiresAt: r.expiresAt.toISOString(), createdBy: r.createdBy,
    }));
    return toCsv(rows, ["number", "request", "customer", "item", "brand", "status", "total", "deposit", "amountPaid", "expiresAt", "createdBy"]);
  },

  // ── customer ──
  async myQuote(customerId: string, requestId: string) {
    const r = await ownedRequest(customerId, requestId);
    const q = r.quotes[0];
    if (!q) throw ApiError.notFound("Quote");
    return {
      request: { id: r.id, number: r.number, itemName: r.itemName, brand: r.brand, status: STATUS_LABELS.concierge.customer[r.status], cartStatus: STATUS_LABELS.concierge.cart[r.status], statusKey: r.status },
      quote: toQuote(q),
      deliveryAddress: r.deliveryAddress,
    };
  },

  async accept(customerId: string, requestId: string, b: AcceptBody) {
    const r = await ownedRequest(customerId, requestId);
    const current = r.quotes[0];
    if (!current) throw ApiError.notFound("Quote");
    if (effectiveStatus(current) === "expired") {
      await expireQuote(current.id);
      throw ApiError.conflict("QUOTE_EXPIRED", `Quote ${current.number} has expired. Message your concierge for an updated price.`);
    }
    const address = await resolveAddress(customerId, b, r.deliveryAddress);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
    const { quote, payment, first } = await prisma.$transaction(async (tx) => {
      const req = await lockRequest(tx, r.id);
      const q = await lockQuote(tx, current.id);
      if (!q || req.quotes[0]?.id !== q.id) throw ApiError.conflict("INVALID_STATE", "This quote was replaced. Please review the new one.");
      if (q.status === "paid") throw ApiError.conflict("INVALID_STATE", "This quote is already paid.");
      if (!["sent", "accepted"].includes(q.status)) throw ApiError.conflict(q.status === "expired" ? "QUOTE_EXPIRED" : "INVALID_STATE", `Quote ${q.number} is ${q.status}.`);
      if (!["quoted", "payment_pending"].includes(req.status)) throw ApiError.conflict("INVALID_STATE", "This request can't be paid right now.");
      await abandonPending(tx, q.id);
      const first = q.status === "sent";
      const updated = await tx.conciergeQuote.update({ where: { id: q.id }, data: { status: "accepted", acceptedAt: q.acceptedAt ?? new Date() }, include: { lines: true } });
      await tx.conciergeRequest.update({ where: { id: req.id }, data: { status: "payment_pending", deliveryAddress: address as Prisma.InputJsonValue } });
      if (first) await addTimeline(tx, req.id, "quote", `Quote ${q.number} accepted. Awaiting payment of ${formatNaira(q.deposit)}.`, "Customer");
      const p = await paymentsService.createRecord(tx, {
        purpose: "concierge", amount: q.deposit, email: customer.email, customerId, targetType: QUOTE_TARGET, targetId: q.id,
        method: b.method, savedMethodId: b.savedMethodId, saveCard: b.saveCard, returnUrl: b.returnUrl,
      });
      return { quote: updated, payment: p, first };
    });
    if (first)
      await notifyStaff("concierge_quote", { title: `Quote accepted · ${r.number}`, body: `${r.contactName} accepted ${quote.number} (${formatNaira(quote.total)}).`, link: `/concierge/inbox?id=${r.id}`, adminId: r.assigneeId });
    const started = await paymentsService.begin(payment.reference);
    return { quote: toQuote((await prisma.conciergeQuote.findUniqueOrThrow({ where: { id: quote.id }, include: { lines: true } })) as QuoteRow), payment: started };
  },

  async payBalance(customerId: string, requestId: string, b: PayBalanceBody) {
    const r = await ownedRequest(customerId, requestId);
    const current = r.quotes[0];
    if (!current || current.status !== "paid" || current.amountPaid >= current.total) throw ApiError.conflict("INVALID_STATE", "Nothing is due on this request.");
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
    const payment = await prisma.$transaction(async (tx) => {
      const q = await lockQuote(tx, current.id);
      if (!q || q.status !== "paid" || q.amountPaid >= q.total) throw ApiError.conflict("INVALID_STATE", "Nothing is due on this request.");
      await abandonPending(tx, q.id);
      return paymentsService.createRecord(tx, {
        purpose: "concierge", amount: q.total - q.amountPaid, email: customer.email, customerId, targetType: QUOTE_TARGET, targetId: q.id,
        method: b.method, savedMethodId: b.savedMethodId, returnUrl: b.returnUrl,
      });
    });
    return { quote: toQuote(current), payment: await paymentsService.begin(payment.reference) };
  },

  async decline(customerId: string, requestId: string, b: DeclineBody) {
    const r = await ownedRequest(customerId, requestId);
    const current = r.quotes[0];
    if (!current) throw ApiError.notFound("Quote");
    const to = b.cancelRequest ? "cancelled" : "sourcing";
    await prisma.$transaction(async (tx) => {
      const req = await lockRequest(tx, r.id);
      const q = await lockQuote(tx, current.id);
      if (!q || !["sent", "accepted", "expired"].includes(q.status) || q.amountPaid > 0) throw ApiError.conflict("INVALID_STATE", `Quote ${current.number} can't be declined.`);
      await abandonPending(tx, q.id);
      await tx.conciergeQuote.update({ where: { id: q.id }, data: { status: "declined", declineReason: b.reason } });
      await addTimeline(tx, req.id, "quote", `Quote ${q.number} declined: ${b.reason}`, "Customer");
      if (["quoted", "payment_pending", "sourcing"].includes(req.status))
        await applyStatus(tx, req, to, "Customer", b.cancelRequest ? "You declined the quote and closed this request" : "You declined the quote. We'll look for another option");
    });
    events.emit("concierge.status_changed", { requestId: r.id, to });
    return this.myQuote(customerId, r.id);
  },

  // ── money ──
  /** delivered: move what the customer paid out of 2200 deposits into revenue (once per request) */
  async recogniseRevenue(requestId: string) {
    const r = await prisma.conciergeRequest.findUnique({ where: { id: requestId }, include: { quotes: { where: { status: "paid" }, orderBy: { createdAt: "desc" }, take: 1 } } });
    const q = r?.quotes[0];
    if (!r || !q || q.amountPaid <= 0) return null;
    const paid = q.amountPaid;
    // amounts in proportion if (exceptionally) not everything was collected
    const share = (n: number) => (paid >= q.total ? n : Math.round((n * paid) / q.total));
    const fee = share(q.serviceFee);
    const ship = share(q.shippingEstimate);
    // VAT inside the prices (inclusive) is split between items and shipping in proportion; VAT added on top is separate
    const vatIncluded = share(q.taxIncluded);
    const vat = vatIncluded + share(q.tax);
    const shipVat = q.itemsTotal + q.shippingEstimate > 0 ? Math.round((vatIncluded * q.shippingEstimate) / (q.itemsTotal + q.shippingEstimate)) : 0;
    const shipNet = ship - shipVat;
    // item sales net of their VAT; absorbs rounding so the journal balances to the kobo
    const items = paid - fee - shipNet - vat;
    const lines = [
      { accountCode: ACC.deposits, debit: paid, credit: 0, memo: `Deposit released · ${q.number}` },
      { accountCode: ACC.fees, debit: 0, credit: fee, memo: "Concierge service fee" },
      { accountCode: ACC.shipping, debit: 0, credit: shipNet, memo: "Shipping" },
      { accountCode: ACC.vat, debit: 0, credit: vat, memo: "VAT" },
      { accountCode: ACC.sales, debit: 0, credit: items, memo: "Sourced item sales" },
    ].filter((l) => l.debit > 0 || l.credit > 0);
    if (items < 0) {
      logger.error({ requestId, paid, fee, shipNet, vat }, "concierge revenue split negative; posting to item sales only");
      return ledgerService.postOnce("order", r.number, { description: `Concierge delivered · ${r.number}`, createdBy: SYSTEM_USER, lines: [lines[0], { accountCode: ACC.sales, debit: 0, credit: paid }] });
    }
    return ledgerService.postOnce("order", r.number, { description: `Concierge delivered · ${r.number} · ${q.number}`, createdBy: SYSTEM_USER, lines });
  },

  /** concierge.expire-quotes: unpaid quotes past expiresAt → expired, request back to sourcing */
  async expireDue(now = new Date()) {
    const due = await prisma.conciergeQuote.findMany({ where: { status: { in: ["sent", "accepted"] }, amountPaid: 0, expiresAt: { lte: now } }, select: { id: true } });
    let n = 0;
    for (const q of due) if (await expireQuote(q.id, now)) n++;
    return n;
  },

  journalDeposit,
};

function adminRow(q: QuoteRow & { request: { id: string; number: string; itemName: string; brand: string | null; status: string; contactName: string; contactEmail: string; assigneeId: string | null } }) {
  return {
    ...toQuote(q),
    createdBy: q.createdBy,
    request: { id: q.request.id, number: q.request.number, itemName: q.request.itemName, brand: q.request.brand, status: q.request.status, customer: q.request.contactName, email: q.request.contactEmail, assigneeId: q.request.assigneeId },
  };
}

paymentsService.register("concierge", {
  async succeeded(tx, p: Payment) {
    const q = p.targetType === QUOTE_TARGET && p.targetId ? await lockQuote(tx, p.targetId) : null;
    const req = q ? await lockRequest(tx, q.requestId) : null;
    const refundAll = async (why: string) => {
      await paymentsService.refund(tx, p.id, p.amount, why, "system");
      if (q) await addTimeline(tx, q.requestId, "note", `Payment ${p.reference} (${formatNaira(p.amount)}) refunded automatically: ${why}.`, "System", true);
      logger.warn({ reference: p.reference, quote: p.targetId, why }, "concierge payment refunded");
    };
    if (!q || !req) return void (await refundAll("Quote not found"));
    if (["declined", "expired"].includes(q.status) || ["cancelled", "unavailable", "delivered"].includes(req.status) || req.quotes[0]?.id !== q.id)
      return void (await refundAll(`Quote ${q.number} is no longer payable`));
    // the quote was revised after this checkout opened and now needs a bigger deposit
    if (q.status !== "paid" && p.amount < q.deposit) return void (await refundAll(`Quote ${q.number} changed`));

    const before = q.amountPaid;
    const paid = Math.min(q.total, before + p.amount);
    const excess = before + p.amount - paid;
    if (excess > 0) await paymentsService.refund(tx, p.id, excess, `Overpayment on ${q.number}`, "system");
    if (paid === before) return; // fully refunded above
    await tx.conciergeQuote.update({ where: { id: q.id }, data: { amountPaid: paid, status: "paid", paidAt: q.paidAt ?? new Date() } });
    const full = paid >= q.total;
    const label = before === 0 ? (full ? "Payment" : "Deposit") : "Balance payment";
    await addTimeline(tx, q.requestId, "status", `${label} of ${formatNaira(paid - before)} received${full ? "" : `. Balance due: ${formatNaira(q.total - paid)}`}.`, "System");
    let to: "ordered" | "approved" | null = null;
    if (full && ["quoted", "payment_pending", "approved"].includes(req.status)) to = "ordered";
    else if (!full && ["quoted", "payment_pending"].includes(req.status)) to = "approved";
    if (to) await applyStatus(tx, req, to, "System", to === "ordered" ? "Payment received - we're placing your order" : `Deposit received. Balance of ${formatNaira(q.total - paid)} is due before dispatch`);
    return async () => {
      await journalDeposit(p.id).catch((err) => logger.error({ err, reference: p.reference }, "concierge deposit journal failed"));
      if (to) events.emit("concierge.status_changed", { requestId: q.requestId, to });
      await notifyStaff("concierge_quote", {
        title: `${label} received · ${q.request.number}`, body: `${formatNaira(paid - before)} on ${q.number}${full ? " (paid in full)" : ""}.`,
        link: `/concierge/inbox?id=${q.requestId}`, adminId: q.request.assigneeId,
      });
    };
  },
  async failed(tx, p: Payment) {
    const q = p.targetId ? await tx.conciergeQuote.findUnique({ where: { id: p.targetId }, select: { requestId: true, number: true } }) : null;
    if (q) await addTimeline(tx, q.requestId, "note", `Payment ${p.reference} for ${q.number} failed.`, "System", true);
  },
});

export const expireQuotesJob = defineJob("concierge.expire-quotes", async () => {
  const n = await quotesService.expireDue();
  if (n) logger.info({ expired: n }, "concierge quotes expired");
});
