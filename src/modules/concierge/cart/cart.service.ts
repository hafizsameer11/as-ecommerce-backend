/**
 * Concierge cart (/concierge/cart → /concierge/payment → /concierge/success).
 * The cart is the customer's open requests (GET /store/concierge/cart lives in ../requests). Here:
 *   - edit a line (qty / size / colour / notes) while nothing is paid. A live quote is withdrawn by the change
 *     and the request goes back to sourcing (the price was for the old details).
 *   - remove a line = cancel the request (before payment); closed requests are not in the cart, so removing them is a no-op.
 *   - checkout: accept every selected quote and pay all deposits / balances in ONE payment (Payment.targetType
 *     "concierge_checkout" → ConciergeCheckout lines). The payment handler in ../quotes splits it per quote.
 */
import type { ConciergeStatus, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { addTimeline, notifyStaff, requestKey } from "../concierge.common";
import { effectiveStatus } from "../quotes/quotes.mapper";
import { abandonPending, CHECKOUT_TARGET, resolveAddress } from "../quotes/quotes.service";
import { requestInclude, toCustomerCard, type RequestRow } from "../requests/requests.mapper";
import { requestsService } from "../requests/requests.service";
import type { CheckoutBody, UpdateItemBody } from "./cart.schemas";

/** statuses shown in the cart (same list as GET /concierge/cart) */
export const CART_STATUSES: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending", "approved"];
/** details can change until a quote is paid */
const EDITABLE: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending"];

async function owned(customerId: string, id: string) {
  const r = await prisma.conciergeRequest.findFirst({ where: { customerId, ...requestKey(id) }, include: requestInclude });
  if (!r) throw ApiError.notFound("Request");
  return r;
}

async function lockRequests(tx: Tx, ids: string[]) {
  // fixed order so two checkouts never deadlock
  for (const id of [...ids].sort()) await tx.$queryRaw`SELECT id FROM \`ConciergeRequest\` WHERE id = ${id} FOR UPDATE`;
  return tx.conciergeRequest.findMany({ where: { id: { in: ids } }, include: requestInclude });
}

/** a chat line written for the team (the customer made the change, so it is unread for staff) */
async function customerNote(db: Tx, requestId: string, text: string) {
  const thread = await db.chatThread.upsert({ where: { requestId }, create: { requestId }, update: {} });
  await db.chatMessage.create({ data: { threadId: thread.id, sender: "system", authorName: "System", text } });
  await db.chatThread.update({ where: { id: thread.id }, data: { unreadAgent: { increment: 1 }, lastAt: new Date() } });
}

/** what one cart line needs now: the quote deposit (first payment) or the balance after a deposit */
function dueFor(r: RequestRow) {
  const q = r.quotes[0];
  const base = { requestId: r.id, number: r.number, itemName: r.itemName, brand: r.brand, statusKey: r.status, cartStatus: STATUS_LABELS.concierge.cart[r.status] };
  if (!q) return { ...base, quoteId: null, kind: null, amountDue: 0, payable: false, reason: "We're still sourcing this item - you'll get a quote soon." };
  const eff = effectiveStatus(q);
  if ((eff === "sent" || eff === "accepted") && ["quoted", "payment_pending"].includes(r.status))
    return { ...base, quoteId: q.id, quoteNumber: q.number, kind: "deposit" as const, amountDue: q.deposit, quoteTotal: q.total, payable: true, reason: null };
  if (q.status === "paid" && q.amountPaid < q.total && r.status === "approved")
    return { ...base, quoteId: q.id, quoteNumber: q.number, kind: "balance" as const, amountDue: q.total - q.amountPaid, quoteTotal: q.total, payable: true, reason: null };
  const reason = eff === "expired" ? `Quote ${q.number} has expired. Message your concierge for an updated price.`
    : q.status === "paid" ? "Already paid." : "Not ready for payment yet.";
  return { ...base, quoteId: q.id, quoteNumber: q.number, kind: null, amountDue: 0, payable: false, reason };
}

type Due = ReturnType<typeof dueFor>;

/** explicit selection: every line must be payable; default: all payable cart lines */
function pick(rows: RequestRow[], requested: string[] | undefined) {
  const lines = rows.map(dueFor);
  if (!requested) {
    const ok = lines.filter((l) => l.payable);
    if (!ok.length) throw ApiError.conflict("INVALID_STATE", "Nothing in your concierge cart is ready to pay yet.");
    return ok;
  }
  const bad = lines.filter((l) => !l.payable);
  if (bad.length) {
    const expired = bad.some((l) => l.reason?.includes("expired"));
    throw ApiError.conflict(expired ? "QUOTE_EXPIRED" : "INVALID_STATE", bad.length === 1 ? `${bad[0].number}: ${bad[0].reason}` : "Some items can't be paid yet.", {
      items: bad.map((l) => ({ requestId: l.requestId, number: l.number, reason: l.reason })),
    });
  }
  return lines;
}

const summary = (lines: Due[]) => ({ items: lines, count: lines.length, amount: lines.reduce((n, l) => n + l.amountDue, 0) });

async function selectRows(db: Tx | typeof prisma, customerId: string, keys?: string[]) {
  if (!keys) return db.conciergeRequest.findMany({ where: { customerId, status: { in: CART_STATUSES } }, include: requestInclude, orderBy: { createdAt: "asc" } });
  const uniq = [...new Set(keys)];
  const rows = await db.conciergeRequest.findMany({ where: { customerId, OR: uniq.map((k) => requestKey(k)) }, include: requestInclude, orderBy: { createdAt: "asc" } });
  const missing = uniq.filter((k) => !rows.some((r) => r.id === k || r.number === k.toUpperCase()));
  if (missing.length) throw ApiError.notFound("Request");
  return rows;
}

export const cartService = {
  /** qty / size / colour / notes. A sent, unpaid quote is withdrawn and the request goes back to sourcing. */
  async updateItem(customerId: string, id: string, b: UpdateItemBody) {
    const found = await owned(customerId, id);

    // concierge-shop items: size / colour must exist on the product; the catalogue price follows the variant
    let price: number | null | undefined;
    if (found.source === "catalog" && found.productId && (b.size !== undefined || b.color !== undefined)) {
      const p = await prisma.product.findUnique({ where: { id: found.productId }, include: { variants: { where: { active: true } }, colors: true } });
      if (p) {
        const size = b.size !== undefined ? b.size : found.size;
        const color = b.color !== undefined ? b.color : found.color;
        const sizes = [...new Set(p.variants.map((v) => v.size).filter(Boolean) as string[])];
        if (sizes.length && !size) throw ApiError.badRequest("VALIDATION_FAILED", "Please choose a size.", [{ in: "body", path: "size", message: "Required", options: sizes }]);
        if (size && sizes.length && !sizes.includes(size)) throw ApiError.badRequest("VALIDATION_FAILED", "That size isn't available for this item.", [{ in: "body", path: "size", options: sizes }]);
        const colors = p.colors.map((c) => c.name);
        if (color && colors.length && !colors.includes(color)) throw ApiError.badRequest("VALIDATION_FAILED", "That colour isn't available for this item.", [{ in: "body", path: "color", options: colors }]);
        const v = p.variants.find((x) => (!size || x.size === size) && (!color || !x.color || x.color === color));
        price = p.priceOnRequest ? null : (v?.price ?? p.price);
      }
    }

    const out = await prisma.$transaction(async (tx) => {
      const [r] = await lockRequests(tx, [found.id]);
      if (r.quotes.some((q) => q.amountPaid > 0) || !EDITABLE.includes(r.status))
        throw ApiError.conflict("INVALID_STATE", "This request has been paid or is being ordered, so its details can't change here. Please message your concierge.");

      const show = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v));
      const changes: string[] = [];
      const data: Prisma.ConciergeRequestUpdateInput = {};
      const set = <K extends "qty" | "size" | "color" | "notes">(k: K, label: string, v: UpdateItemBody[K]) => {
        if (v === undefined) return;
        const next = v === "" ? null : v;
        if ((next ?? null) === (r[k] ?? null)) return;
        (data as Record<string, unknown>)[k] = next;
        changes.push(k === "notes" ? "notes updated" : `${label} ${show(r[k])} → ${show(next)}`);
      };
      set("qty", "qty", b.qty);
      set("size", "size", b.size);
      set("color", "colour", b.color);
      set("notes", "notes", b.notes);
      if (!changes.length) return { r, changes, withdrawn: null as string | null, statusChanged: false };
      if (price !== undefined) data.price = price;

      // the quote was priced for the old details: withdraw it and source again
      const live = r.quotes.find((q) => ["sent", "accepted"].includes(q.status) && q.amountPaid === 0);
      let withdrawn: string | null = null;
      if (live) {
        await abandonPending(tx, live.id);
        await tx.conciergeQuote.update({ where: { id: live.id }, data: { status: "expired" } });
        withdrawn = live.number;
      }
      const statusChanged = ["quoted", "payment_pending"].includes(r.status);
      if (statusChanged) data.status = "sourcing";
      await tx.conciergeRequest.update({ where: { id: r.id }, data });
      const text = `You changed the details: ${changes.join("; ")}.`;
      await addTimeline(tx, r.id, "note", withdrawn ? `${text} Quote ${withdrawn} was withdrawn - we'll send an updated price.` : text, "Customer");
      if (statusChanged) await addTimeline(tx, r.id, "status", `Status updated: ${STATUS_LABELS.concierge.customer.sourcing}`, "Customer");
      await customerNote(tx, r.id, `Customer changed the details: ${changes.join("; ")}.${withdrawn ? ` Quote ${withdrawn} withdrawn - please re-quote.` : ""}`);
      return { r, changes, withdrawn, statusChanged };
    });

    if (out.statusChanged) events.emit("concierge.status_changed", { requestId: found.id, to: "sourcing" });
    if (out.withdrawn)
      await notifyStaff("concierge_quote", {
        title: `Re-quote needed · ${found.number}`, body: `${found.contactName} changed ${out.changes.join("; ")}. Quote ${out.withdrawn} was withdrawn.`,
        link: `/concierge/inbox?id=${found.id}`, adminId: found.assigneeId,
      });
    return { item: toCustomerCard(await owned(customerId, found.id)), changed: out.changes, quoteWithdrawn: out.withdrawn };
  },

  /** trash icon: cancel the request (only before payment). Requests already closed aren't in the cart: nothing to do. */
  async removeItem(customerId: string, id: string, reason?: string) {
    const r = await owned(customerId, id);
    if (!CART_STATUSES.includes(r.status)) return { removed: true, action: "none" as const, requestId: r.id, number: r.number };
    const request = await requestsService.cancelByCustomer(customerId, r.id, reason ?? "Removed from the concierge cart");
    return { removed: true, action: "cancelled" as const, requestId: r.id, number: r.number, request };
  },

  /** "Clear Cart": cancels everything that can still be cancelled; paid items stay (with the reason) */
  async clear(customerId: string) {
    const rows = await prisma.conciergeRequest.findMany({ where: { customerId, status: { in: CART_STATUSES } }, include: requestInclude });
    const cancelled: string[] = [];
    const kept: { requestId: string; number: string; reason: string }[] = [];
    for (const r of rows) {
      try {
        await requestsService.cancelByCustomer(customerId, r.id, "Removed from the concierge cart");
        cancelled.push(r.number);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        kept.push({ requestId: r.id, number: r.number, reason: err.message });
      }
    }
    return { cancelled, kept };
  },

  /** /concierge/payment summary: what can be paid now and how much */
  async preview(customerId: string, ids?: string[]) {
    const rows = await selectRows(prisma, customerId, ids);
    const lines = rows.map(dueFor);
    const payable = lines.filter((l) => l.payable);
    return { ...summary(payable), notPayable: lines.filter((l) => !l.payable) };
  },

  /** accept + pay several quotes at once → `{ checkout, payment }` (open payment.authorizationUrl) */
  async checkout(customerId: string, b: CheckoutBody) {
    const pre = pick(await selectRows(prisma, customerId, b.requestIds), b.requestIds);
    const needsAddress = pre.some((l) => l.kind === "deposit");
    const first = needsAddress ? await prisma.conciergeRequest.findUnique({ where: { id: pre.find((l) => l.kind === "deposit")!.requestId }, select: { deliveryAddress: true } }) : null;
    const address = needsAddress ? await resolveAddress(customerId, b, first?.deliveryAddress) : null;
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });

    const { checkout, payment, lines, accepted } = await prisma.$transaction(async (tx) => {
      const rows = await lockRequests(tx, pre.map((l) => l.requestId));
      for (const r of rows) for (const q of r.quotes.slice(0, 1)) await tx.$queryRaw`SELECT id FROM \`ConciergeQuote\` WHERE id = ${q.id} FOR UPDATE`;
      // re-check under the locks (a quote may have been revised / paid meanwhile)
      const lines = pick(rows, pre.map((l) => l.requestId));
      if (lines.some((l) => l.amountDue !== pre.find((p) => p.requestId === l.requestId)?.amountDue))
        throw ApiError.conflict("INVALID_STATE", "A quote in your cart was just updated. Please review the new total.");
      const accepted: string[] = [];
      for (const l of lines) {
        const r = rows.find((x) => x.id === l.requestId)!;
        const q = r.quotes[0];
        await abandonPending(tx, q.id);
        if (l.kind === "deposit") {
          if (q.status === "sent") {
            accepted.push(r.number);
            await addTimeline(tx, r.id, "quote", `Quote ${q.number} accepted. Awaiting payment of ${formatNaira(q.deposit)}.`, "Customer");
          }
          await tx.conciergeQuote.update({ where: { id: q.id }, data: { status: "accepted", acceptedAt: q.acceptedAt ?? new Date() } });
          await tx.conciergeRequest.update({
            where: { id: r.id },
            data: { status: "payment_pending", deliveryAddress: address as Prisma.InputJsonValue, ...(b.phone ? { contactPhone: b.phone } : {}) },
          });
        }
      }
      const amount = lines.reduce((n, l) => n + l.amountDue, 0);
      const checkout = await tx.conciergeCheckout.create({
        data: { customerId, amount, lines: { create: lines.map((l) => ({ quoteId: l.quoteId!, requestId: l.requestId, kind: l.kind!, amount: l.amountDue })) } },
      });
      const payment = await paymentsService.createRecord(tx, {
        purpose: "concierge", amount, email: customer.email, customerId, targetType: CHECKOUT_TARGET, targetId: checkout.id,
        method: b.method, savedMethodId: b.savedMethodId, saveCard: b.saveCard, returnUrl: b.returnUrl,
      });
      await tx.conciergeCheckout.update({ where: { id: checkout.id }, data: { paymentRef: payment.reference } });
      return { checkout, payment, lines, accepted };
    });

    if (accepted.length)
      await notifyStaff("concierge_quote", {
        title: `Quotes accepted · ${accepted.join(", ")}`, body: `Cart checkout of ${formatNaira(checkout.amount)} for ${lines.length} item(s).`, link: "/concierge/quotes",
      });
    const started = await paymentsService.begin(payment.reference);
    return { checkout: { id: checkout.id, ...summary(lines) }, payment: started };
  },

  /** /concierge/success: the checkout, its payment status and the requests now in progress */
  async getCheckout(customerId: string, id: string) {
    const c = await prisma.conciergeCheckout.findFirst({ where: { id, customerId }, include: { lines: true } });
    if (!c) throw ApiError.notFound("Checkout");
    const rows = await prisma.conciergeRequest.findMany({ where: { id: { in: c.lines.map((l) => l.requestId) } }, include: requestInclude });
    return {
      id: c.id,
      amount: c.amount,
      createdAt: c.createdAt,
      payment: c.paymentRef ? await paymentsService.publicStatus(c.paymentRef, customerId) : null,
      items: c.lines.map((l) => {
        const r = rows.find((x) => x.id === l.requestId);
        return { kind: l.kind, amount: l.amount, refunded: l.refunded, request: r ? toCustomerCard(r) : null };
      }),
    };
  },
};
