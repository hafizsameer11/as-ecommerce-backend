import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import type { SettleLayawayBody } from "./pos.schemas";
import { posGiftCardsService } from "./pos.giftcards.service";

type Staff = { id: string; name: string };

export const posLayawayService = {
  async get(orderIdOrNumber: string) {
    const order = await prisma.order.findFirst({
      where: { OR: [{ id: orderIdOrNumber }, { number: orderIdOrNumber }], channel: "store" },
      include: { items: true, payments: true },
    });
    if (!order) throw ApiError.notFound("Layaway");
    const layaway = await prisma.posLayaway.findUnique({ where: { orderId: order.id } });
    if (!layaway) throw ApiError.notFound("Layaway");
    return { order, layaway };
  },

  async settle(orderIdOrNumber: string, body: SettleLayawayBody, staff: Staff) {
    const { order, layaway } = await this.get(orderIdOrNumber);
    if (layaway.status !== "open") throw ApiError.conflict("INVALID_STATE", "This layaway is no longer open.");
    if (layaway.until < new Date()) throw ApiError.conflict("INVALID_STATE", "This layaway hold has expired.");

    const paid = body.payments.reduce((a, p) => a + p.amount, 0);
    if (paid - body.change !== layaway.balance) {
      throw ApiError.badRequest("VALIDATION_FAILED", `Balance due is ₦${Math.round(layaway.balance / 100).toLocaleString("en-NG")}.`);
    }

    const session = body.registerSessionId
      ? await prisma.posRegisterSession.findUnique({
          where: { id: body.registerSessionId },
          include: { register: true },
        })
      : order.registerSessionId
        ? await prisma.posRegisterSession.findUnique({
            where: { id: order.registerSessionId },
            include: { register: true },
          })
        : null;
    if (!session || session.closedAt) throw ApiError.conflict("INVALID_STATE", "Open a register session to settle.");

    const warehouseId = session.register.warehouseId;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      for (const p of body.payments) {
        if (p.method === "giftcard") {
          if (!p.reference) throw ApiError.badRequest("VALIDATION_FAILED", "Gift card code required.");
          await posGiftCardsService.redeem(p.reference, p.amount, order.number, staff.id);
        }
        if (p.method === "wallet") {
          if (!order.customerId) throw ApiError.badRequest("VALIDATION_FAILED", "Wallet needs a customer.");
          await walletsService.spend(tx, order.customerId, p.amount, order.number);
        }
        await tx.payment.create({
          data: {
            reference: `POS-${order.number}-balance-${p.method}-${Math.random().toString(36).slice(2, 8)}`,
            provider: "pos",
            purpose: "order",
            method: p.method,
            status: "succeeded",
            amount: p.amount,
            customerId: order.customerId ?? undefined,
            email: order.guestEmail ?? "pos@asloriginals.local",
            orderId: order.id,
            paidAt: now,
            providerData: p.reference ? { reference: p.reference } : undefined,
          },
        });
      }

      await inventoryService.commitSale(tx, { type: "order", id: order.id });

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "delivered",
          paymentStatus: "paid",
          amountPaid: order.total,
          paidAt: now,
          deliveredAt: now,
          changeGiven: body.change,
          events: {
            create: {
              type: "delivered",
              title: "Layaway settled & handed over",
              detail: body.payments.map((p) => `${p.method} ₦${Math.round(p.amount / 100)}`).join(" · "),
              actor: staff.name,
            },
          },
        },
      });

      await tx.posLayaway.update({
        where: { id: layaway.id },
        data: { status: "paid", balance: 0, paidAt: now },
      });

      await tx.posAuditEvent.create({
        data: {
          locationId: session.register.locationId,
          registerId: session.registerId,
          sessionId: session.id,
          staffId: staff.id,
          action: "reservation",
          text: `${staff.name} settled layaway ${order.number}`,
          amount: layaway.balance,
          ref: order.number,
        },
      });
      void warehouseId;
    });

    events.emit("order.paid", { orderId: order.id });
    events.emit("order.delivered", { orderId: order.id });
    return this.get(order.id);
  },

  async cancel(orderIdOrNumber: string, staff: Staff, forfeitDeposit = true) {
    const { order, layaway } = await this.get(orderIdOrNumber);
    if (layaway.status !== "open") throw ApiError.conflict("INVALID_STATE", "This layaway is no longer open.");

    await prisma.$transaction(async (tx) => {
      await inventoryService.release(tx, { type: "order", id: order.id });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "cancelled",
          cancelReason: forfeitDeposit ? "Layaway cancelled (deposit forfeited)" : "Layaway cancelled",
          cancelledAt: new Date(),
          events: {
            create: {
              type: "cancelled",
              title: "Layaway cancelled",
              detail: forfeitDeposit ? "Deposit forfeited" : undefined,
              actor: staff.name,
            },
          },
        },
      });
      await tx.posLayaway.update({ where: { id: layaway.id }, data: { status: "cancelled" } });
      if (order.registerId) {
        await tx.posAuditEvent.create({
          data: {
            locationId: (await tx.posRegister.findUniqueOrThrow({ where: { id: order.registerId } })).locationId,
            registerId: order.registerId,
            sessionId: order.registerSessionId ?? undefined,
            staffId: staff.id,
            action: "reservation",
            text: `${staff.name} cancelled layaway ${order.number}`,
            amount: layaway.deposit,
            ref: order.number,
          },
        });
      }
    });

    return this.get(order.id);
  },
};
