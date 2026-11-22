import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { logger } from "@/core/utils/logger";
import { formatNaira } from "@/core/utils/money";
import { messaging, type Vars } from "@/modules/marketing/messaging/messaging.service";
import { mail } from "@/providers/mail/mail";
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

function moneyVars(payload: Record<string, unknown>): Vars {
  const vars: Vars = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null) continue;
    if (typeof v === "number" && /amount|total|fee|balance|deposit|price/i.test(k)) {
      vars[k] = formatNaira(v);
    } else if (typeof v === "string" || typeof v === "number") {
      vars[k] = v;
    }
  }
  return vars;
}

function receiptVars(payload: Record<string, unknown>): Vars {
  const items = Array.isArray(payload.items) ? (payload.items as { name: string; brand: string; qty: number; lineTotal: number | null }[]) : [];
  const payments = Array.isArray(payload.payments) ? (payload.payments as { method: string; amount: number }[]) : [];
  const gift = !!payload.gift;
  return {
    ...moneyVars(payload),
    customerName: String(payload.customerName ?? "Customer"),
    orderNumber: String(payload.orderNumber ?? ""),
    footer: String(payload.footer ?? ""),
    total: typeof payload.total === "number" ? formatNaira(payload.total) : String(payload.total ?? ""),
    itemLines: items
      .map((i) =>
        gift || i.lineTotal == null
          ? `• ${i.qty} × ${i.brand} ${i.name}`
          : `• ${i.qty} × ${i.brand} ${i.name} — ${formatNaira(i.lineTotal)}`,
      )
      .join("\n"),
    paymentLines: payments.map((p) => `${p.method} ${formatNaira(p.amount)}`).join(" · ") || "—",
  };
}

function pickupVars(payload: Record<string, unknown>): Vars {
  return {
    ...moneyVars(payload),
    orderNumber: String(payload.orderNumber ?? ""),
    pickupCode: String(payload.pickupCode ?? ""),
    location: String(payload.store ?? payload.location ?? ""),
    store: String(payload.store ?? ""),
    address: String(payload.address ?? ""),
    hours: String(payload.hours ?? ""),
    firstName: String(payload.firstName ?? payload.customerName ?? "there"),
    customerName: String(payload.customerName ?? "Customer"),
    orderUrl: "/account/orders",
  };
}

function varsFor(template: string, payload: Record<string, unknown>): Vars {
  if (template === "pos.receipt" || template === "pos.gift_receipt") return receiptVars(payload);
  if (template.startsWith("pickup.")) return pickupVars(payload);
  if (template === "pos.return_slip") {
    return {
      ...moneyVars(payload),
      customerName: String(payload.customerName ?? "Customer"),
      orderNumber: String(payload.orderNumber ?? ""),
      returnNumber: String(payload.returnNumber ?? ""),
      refundTo: String(payload.refundTo ?? "original"),
      amount: typeof payload.amount === "number" ? formatNaira(payload.amount) : String(payload.amount ?? ""),
    };
  }
  return moneyVars(payload);
}

/**
 * Queues till outbound messages. **Email is sent now** via SMTP/`mail`.
 * SMS / WhatsApp / push stay `pending` until those providers are wired.
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

    if (input.channel === "email") {
      const sent = await this.dispatchEmail(row.id);
      return { id: row.id, status: sent.status };
    }

    return { id: row.id, status: "pending" as const };
  },

  /** Send one pending email row (or re-try). */
  async dispatchEmail(id: string) {
    const row = await prisma.posOutboundMessage.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound("Outbound message");
    if (row.channel !== "email") {
      return { id: row.id, status: row.status as "pending" | "sent" | "failed", reason: "Not an email channel" };
    }
    if (row.status === "sent") return { id: row.id, status: "sent" as const };

    const payload = (row.payload ?? {}) as Record<string, unknown>;
    try {
      const rendered = await messaging.render(row.template, "email", varsFor(row.template, payload));
      if (!rendered) throw new Error(`No active email template for ${row.template}`);
      await mail.send({
        to: row.to,
        subject: rendered.subject || row.template,
        text: rendered.body,
        html: await messaging.emailHtml(rendered.subject || row.template, rendered.body, rendered.ctaLabel, rendered.link, {
          preheader: rendered.preheader,
        }),
      });
      await prisma.posOutboundMessage.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), error: null },
      });
      await prisma.messageTemplate.updateMany({
        where: { code: row.template, channel: "email" },
        data: { sentCount: { increment: 1 } },
      });
      return { id: row.id, status: "sent" as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Email send failed";
      logger.error({ err, id: row.id, template: row.template }, "pos outbound email failed");
      await prisma.posOutboundMessage.update({
        where: { id: row.id },
        data: { status: "failed", error: message },
      });
      return { id: row.id, status: "failed" as const, reason: message };
    }
  },

  /** Flush any email rows still stuck in pending (e.g. after SMTP was down). */
  async flushPendingEmails(limit = 50) {
    const rows = await prisma.posOutboundMessage.findMany({
      where: { status: "pending", channel: "email" },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    const results = [];
    for (const r of rows) results.push(await this.dispatchEmail(r.id));
    return { processed: results.length, results };
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

    // Prefer email for now when the till asks for SMS/WhatsApp but we have an address
    let channel = body.channel;
    let dest = channel === "email" ? email : phone;
    if (channel !== "email" && email && !phone) {
      channel = "email";
      dest = email;
    }
    if (channel === "email" && !dest && email) dest = email;
    if (!dest) {
      throw ApiError.badRequest(
        "VALIDATION_FAILED",
        channel === "email" ? "No e-mail on this order." : "No phone on this order (and no e-mail to fall back to).",
      );
    }

    const pos = await settingsService.get("pos");
    const template = body.gift ? "pos.gift_receipt" : "pos.receipt";
    const queued = await this.enqueue({
      channel,
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
        text: `${queued.status === "sent" ? "Sent" : "Queued"} ${template} via ${channel} to ${dest} for ${o.number}`,
        ref: o.number,
      },
    });

    return {
      ...queued,
      channel,
      template,
      to: dest,
      note:
        channel === "email"
          ? queued.status === "sent"
            ? "Receipt emailed."
            : queued.status === "failed"
              ? "Email failed — check SMTP settings / message row."
              : "Queued."
          : "Queued as pending — SMS/WhatsApp/push providers are not connected yet (email works).",
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
