import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SendReceiptBody } from "./pos.schemas";

type EnqueueInput = {
  channel: "email" | "sms" | "whatsapp" | "push";
  template: string;
  to: string;
  orderId?: string;
  returnId?: string;
  bookingId?: string;
  staffId?: string;
  payload: Record<string, unknown>;
};

/**
 * Queues customer messages from the till. Providers are NOT called here (Phase 5).
 * Rows stay `pending` until a worker / provider integration picks them up.
 */
export const posOutboundService = {
  async enqueue(input: EnqueueInput) {
    if (!input.to || input.to === "unknown") {
      return { id: null as string | null, status: "skipped" as const, reason: "No destination address" };
    }
    const row = await prisma.posOutboundMessage.create({
      data: {
        channel: input.channel,
        template: input.template,
        to: input.to,
        status: "pending",
        orderId: input.orderId,
        returnId: input.returnId,
        bookingId: input.bookingId,
        staffId: input.staffId,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
    return { id: row.id, status: row.status as "pending" };
  },

  async sendReceipt(orderRef: string, body: SendReceiptBody, staffId: string) {
    const o = await prisma.order.findFirst({
      where: { OR: [{ id: orderRef }, { number: orderRef }], channel: { in: ["store", "web", "mobile", "pwa"] } },
      include: {
        items: true,
        payments: true,
        customer: { select: { email: true, phone: true, firstName: true, lastName: true } },
      },
    });
    if (!o) throw ApiError.notFound("Sale");

    const contact = (o.contact ?? {}) as { email?: string; phone?: string };
    const email = body.to?.trim() || contact.email || o.customer?.email || o.guestEmail || "";
    const phone = body.to?.trim() || contact.phone || o.customer?.phone || "";
    const dest = body.channel === "email" ? email : phone;
    if (!dest) throw ApiError.badRequest("VALIDATION_FAILED", `No ${body.channel === "email" ? "e-mail" : "phone"} on this order.`);

    const pos = await settingsService.get("pos");
    const template = body.gift ? "pos.gift_receipt" : "pos.receipt";
    const queued = await this.enqueue({
      channel: body.channel,
      template,
      to: dest,
      orderId: o.id,
      staffId,
      payload: {
        orderNumber: o.number,
        total: o.total,
        gift: !!body.gift,
        items: o.items.map((i) => ({
          name: i.name,
          brand: i.brand,
          qty: i.qty,
          lineTotal: body.gift ? null : i.lineTotal,
        })),
        payments: body.gift ? [] : o.payments.map((p) => ({ method: p.method, amount: p.amount })),
        footer: pos.receiptFooter,
        customerName: o.customer ? [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" ") : contact.email ?? "Customer",
      },
    });

    await prisma.posAuditEvent.create({
      data: {
        staffId,
        action: "sale",
        text: `Queued ${template} via ${body.channel} to ${dest} for ${o.number}`,
        ref: o.number,
      },
    });

    return {
      ...queued,
      channel: body.channel,
      template,
      to: dest,
      note: "Queued as pending — SMS/WhatsApp/email providers are not connected yet.",
    };
  },

  async listPending(limit = 50) {
    return prisma.posOutboundMessage.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  },
};
