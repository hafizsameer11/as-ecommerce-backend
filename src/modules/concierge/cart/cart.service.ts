/**
 * Concierge cart line edits (/concierge/cart UI).
 * The cart is the customer's open requests (GET /store/concierge/cart lives in ../requests).
 */
import type { ConciergeStatus, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { addTimeline, notifyStaff, requestKey } from "../concierge.common";
import { abandonPending } from "../quotes/quotes.service";
import { requestInclude, toCustomerCard } from "../requests/requests.mapper";
import { requestsService } from "../requests/requests.service";
import type { UpdateItemBody } from "./cart.schemas";

/** statuses shown in the cart (same list as GET /concierge/cart) */
export const CART_STATUSES: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending", "approved"];
/** details can change until a quote is paid */
const EDITABLE: ConciergeStatus[] = ["new", "sourcing", "quoted", "payment_pending"];

async function owned(customerId: string, id: string) {
  const r = await prisma.conciergeRequest.findFirst({ where: { customerId, ...requestKey(id) }, include: requestInclude });
  if (!r) throw ApiError.notFound("Request");
  return r;
}

async function lockRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`ConciergeRequest\` WHERE id = ${id} FOR UPDATE`;
  return tx.conciergeRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
}

/** a chat line written for the team (the customer made the change, so it is unread for staff) */
async function customerNote(db: Tx, requestId: string, text: string) {
  const thread = await db.chatThread.upsert({ where: { requestId }, create: { requestId }, update: {} });
  await db.chatMessage.create({ data: { threadId: thread.id, sender: "system", authorName: "System", text } });
  await db.chatThread.update({ where: { id: thread.id }, data: { unreadAgent: { increment: 1 }, lastAt: new Date() } });
}

export const cartService = {
  /** qty / size / colour / notes. A sent, unpaid quote is withdrawn and the request goes back to sourcing. */
  async updateItem(customerId: string, id: string, b: UpdateItemBody) {
    const found = await owned(customerId, id);

    // concierge-shop items: size / colour must exist on the product; the catalogue price follows the variant
    let price: number | null | undefined;
    if (found.source === "catalog" && found.productId && (b.size !== undefined || b.color !== undefined)) {
      const p = await prisma.product.findUnique({
        where: { id: found.productId },
        include: { variants: { where: { active: true } }, colors: true },
      });
      if (p) {
        const size = b.size !== undefined ? b.size : found.size;
        const color = b.color !== undefined ? b.color : found.color;
        const sizes = [...new Set(p.variants.map((v) => v.size).filter(Boolean) as string[])];
        if (sizes.length && !size) throw ApiError.badRequest("VALIDATION_FAILED", "Please choose a size.", [{ in: "body", path: "size", message: "Required", options: sizes }]);
        if (size && sizes.length && !sizes.includes(size))
          throw ApiError.badRequest("VALIDATION_FAILED", "That size isn't available for this item.", [{ in: "body", path: "size", options: sizes }]);
        const colors = p.colors.map((c) => c.name);
        if (color && colors.length && !colors.includes(color))
          throw ApiError.badRequest("VALIDATION_FAILED", "That colour isn't available for this item.", [{ in: "body", path: "color", options: colors }]);
        const v = p.variants.find((x) => (!size || x.size === size) && (!color || !x.color || x.color === color));
        price = p.priceOnRequest ? null : (v?.price ?? p.price);
      }
    }

    const out = await prisma.$transaction(async (tx) => {
      const r = await lockRequest(tx, found.id);
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
        title: `Re-quote needed · ${found.number}`,
        body: `${found.contactName} changed ${out.changes.join("; ")}. Quote ${out.withdrawn} was withdrawn.`,
        link: `/concierge/inbox?id=${found.id}`,
        adminId: found.assigneeId,
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
};