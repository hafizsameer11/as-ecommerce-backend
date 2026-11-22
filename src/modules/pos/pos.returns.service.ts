import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { formatNaira } from "@/core/utils/money";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { ordersService } from "@/modules/commerce/orders/orders.service";
import { refundFor } from "./pos.pricing";
import { posOutboundService } from "./pos.outbound.service";
import type { PosReturnBody } from "./pos.schemas";

const RETURNABLE: OrderStatus[] = ["delivered", "partially_refunded"];
const DAY = 86_400_000;

type Staff = { id: string; name: string };

const orderInclude = {
  items: { include: { product: { select: { category: { select: { handle: true, name: true } }, subcategory: { select: { handle: true } } } } } },
  payments: true,
} satisfies Prisma.OrderInclude;

export const posReturnsService = {
  async returnable(orderRef: string) {
    const pos = await settingsService.get("pos");
    const cfg = await settingsService.get("returns");
    const windowDays = pos.returnWindowDays || cfg.windowDays;
    const blocked = new Set([...(pos.finalSaleCategories ?? []), ...(cfg.nonReturnableCategories ?? [])].map((h) => h.toLowerCase()));

    const o = await prisma.order.findFirst({
      where: { OR: [{ id: orderRef }, { number: orderRef }] },
      include: orderInclude,
    });
    if (!o) throw ApiError.notFound("Order");

    const open = await openReturnQty(o.id);
    const delivered = RETURNABLE.includes(o.status);
    const deliveredAt = delivered ? (o.deliveredAt ?? o.updatedAt) : o.deliveredAt;
    const windowEndsAt = deliveredAt ? new Date(deliveredAt.getTime() + windowDays * DAY) : null;
    const windowClosed = !!windowEndsAt && Date.now() > windowEndsAt.getTime();

    const items = o.items.map((i) => {
      const requested = open.get(i.id) ?? 0;
      const remaining = Math.max(0, i.qty - i.qtyReturned - requested);
      const cat = i.product?.category.handle.toLowerCase();
      const sub = i.product?.subcategory?.handle.toLowerCase();
      const nameHit = blocked.has(i.name.toLowerCase());
      const finalSale = (!!cat && blocked.has(cat)) || (!!sub && blocked.has(sub)) || nameHit;
      let reason: string | null = null;
      if (!delivered) reason = "NOT_DELIVERED";
      else if (windowClosed) reason = "RETURN_WINDOW_CLOSED";
      else if (finalSale) reason = "FINAL_SALE";
      else if (remaining <= 0) reason = "ALREADY_RETURNED";
      const alreadyAmt = Math.round((i.lineTotal * i.qtyReturned) / Math.max(1, i.qty));
      return {
        orderItemId: i.id,
        name: i.name,
        brand: i.brand,
        sku: i.sku,
        size: i.size,
        color: i.color,
        image: i.imageUrl,
        bought: i.qty,
        returned: i.qtyReturned,
        returnable: reason ? 0 : remaining,
        unitNet: Math.round(i.lineTotal / Math.max(1, i.qty)),
        refundPreview: reason ? 0 : refundFor(i.lineTotal, i.qty, i.qtyReturned, alreadyAmt, Math.min(1, remaining)),
        reason,
      };
    });

    return {
      orderId: o.id,
      orderNumber: o.number,
      channel: o.channel,
      status: o.status,
      deliveredAt,
      windowDays,
      windowEndsAt,
      eligible: items.some((i) => i.returnable > 0),
      approvalOver: pos.refundApprovalOver,
      refundOptions: ["original", "wallet", "cash"] as const,
      items,
      reasons: ["Changed mind", "Wrong size / fit", "Faulty / damaged", "Not as described", "Incorrect item", "Other"],
    };
  },

  /** In-store return: create RMA → restock → refund in one step. */
  async process(orderRef: string, body: PosReturnBody, staff: Staff) {
    const assess = await this.returnable(orderRef);
    const pos = await settingsService.get("pos");
    if (!assess.eligible && !body.override) throw ApiError.badRequest("VALIDATION_FAILED", "Nothing on this order can be returned.");

    const o = await prisma.order.findFirstOrThrow({
      where: { id: assess.orderId },
      include: orderInclude,
    });

    for (const line of body.lines) {
      const it = assess.items.find((i) => i.orderItemId === line.orderItemId);
      if (!it) throw ApiError.badRequest("VALIDATION_FAILED", "Item is not on this order.");
      if (!body.override && line.qty > it.returnable) {
        throw ApiError.badRequest("VALIDATION_FAILED", `${it.name}: you can return up to ${it.returnable}.`);
      }
      if (!body.override && it.reason === "FINAL_SALE") {
        throw ApiError.badRequest("VALIDATION_FAILED", `${it.name} is final sale unless faulty — use override with approval.`);
      }
    }

    let amount = 0;
    for (const line of body.lines) {
      const item = o.items.find((i) => i.id === line.orderItemId)!;
      const alreadyAmt = Math.round((item.lineTotal * item.qtyReturned) / Math.max(1, item.qty));
      amount += refundFor(item.lineTotal, item.qty, item.qtyReturned, alreadyAmt, line.qty);
    }
    amount = Math.min(amount, o.amountPaid - o.amountRefunded);
    if (body.amount != null) amount = Math.min(body.amount, o.amountPaid - o.amountRefunded);
    if (amount <= 0) throw ApiError.conflict("INVALID_STATE", "Nothing left to refund.");

    if (amount > pos.refundApprovalOver && !body.approvedById) {
      throw ApiError.forbidden(`Refunds over ${formatNaira(pos.refundApprovalOver)} need a supervisor PIN.`);
    }
    if (body.refundTo === "wallet" && !o.customerId) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Guest orders can't refund to ASL Wallet — use cash or original.");
    }

    const warehouseId = body.warehouseId
      ?? (body.registerSessionId
        ? (await prisma.posRegisterSession.findUnique({ where: { id: body.registerSessionId }, include: { register: true } }))?.register.warehouseId
        : undefined);

    const ret = await prisma.$transaction(async (tx) => {
      const number = formatters.return(await nextSequence(tx, "return", 2210));
      const now = new Date();
      const r = await tx.returnRequest.create({
        data: {
          number,
          orderId: o.id,
          customerId: o.customerId,
          reason: body.reason,
          details: body.note ?? null,
          refundTo: body.refundTo,
          refundAmount: amount,
          status: "approved",
          restocked: false,
          items: { create: body.lines.map((l) => ({ orderItemId: l.orderItemId, qty: l.qty })) },
          events: {
            create: [
              { status: "requested", note: `Till return by ${staff.name}`, actor: staff.name },
              { status: "approved", note: body.override ? "Approved with policy override" : "Approved at till", actor: staff.name },
            ],
          },
        },
      });

      if (body.restock !== false) {
        for (const line of body.lines) {
          const item = o.items.find((i) => i.id === line.orderItemId)!;
          if (item.variantId && warehouseId) {
            await tx.stockLevel.upsert({
              where: { variantId_warehouseId: { variantId: item.variantId, warehouseId } },
              create: { variantId: item.variantId, warehouseId, onHand: line.qty },
              update: { onHand: { increment: line.qty } },
            });
            await tx.stockMovement.create({
              data: {
                sku: item.sku ?? item.variantId,
                variantId: item.variantId,
                warehouseId,
                type: "return",
                qty: line.qty,
                note: `POS return ${number}`,
                refType: "return",
                refId: r.id,
                actor: staff.name,
              },
            });
          } else if (item.variantId) {
            await inventoryService.restock(tx, item.variantId, line.qty, { type: "return", id: r.id }, staff.name);
          }
        }
        await tx.returnRequest.update({ where: { id: r.id }, data: { restocked: true } });
        await tx.returnEvent.create({ data: { returnId: r.id, status: "received", actor: staff.name, note: "Restocked at boutique" } });
      }

      await tx.posAuditEvent.create({
        data: {
          locationId: body.locationId,
          registerId: body.registerId,
          sessionId: body.registerSessionId,
          staffId: staff.id,
          approvedById: body.approvedById,
          action: "refund",
          text: `${staff.name} returned ${number} on ${o.number}: ${formatNaira(amount)} to ${body.refundTo}`,
          amount,
          ref: number,
        },
      });

      return { id: r.id, number, createdAt: now };
    });

    await ordersService.refund(o.id, { amount, reason: `Return ${ret.number}`, to: body.refundTo, restock: false }, staff.name, {
      inTx: async (tx) => {
        await tx.returnRequest.update({
          where: { id: ret.id },
          data: { status: "refunded", refundAmount: amount, refundedAt: new Date() },
        });
        for (const l of body.lines) {
          await tx.orderItem.update({ where: { id: l.orderItemId }, data: { qtyReturned: { increment: l.qty } } });
        }
        const items = await tx.orderItem.findMany({ where: { orderId: o.id }, select: { qty: true, qtyReturned: true } });
        if (items.every((i) => i.qtyReturned >= i.qty)) {
          await tx.order.update({ where: { id: o.id }, data: { status: "returned" } });
        }
        await tx.returnEvent.create({
          data: {
            returnId: ret.id,
            status: "refunded",
            actor: staff.name,
            note: `${formatNaira(amount)} to ${body.refundTo}`,
          },
        });
      },
    });

    events.emit("return.updated", { returnId: ret.id, status: "refunded" });

    await posOutboundService.enqueue({
      channel: "email",
      template: "pos.return_slip",
      to: o.guestEmail ?? (o.customerId ? (await prisma.customer.findUnique({ where: { id: o.customerId } }))?.email : null) ?? "unknown",
      orderId: o.id,
      returnId: ret.id,
      staffId: staff.id,
      payload: { orderNumber: o.number, returnNumber: ret.number, amount, refundTo: body.refundTo },
    });

    return {
      id: ret.id,
      number: ret.number,
      orderId: o.id,
      orderNumber: o.number,
      amount,
      refundTo: body.refundTo,
      restocked: body.restock !== false,
    };
  },
};

async function openReturnQty(orderId: string) {
  const rows = await prisma.returnItem.findMany({
    where: { returnReq: { orderId, status: { notIn: ["rejected", "refunded"] } } },
    select: { orderItemId: true, qty: true },
  });
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.orderItemId, (m.get(r.orderItemId) ?? 0) + r.qty);
  return m;
}
