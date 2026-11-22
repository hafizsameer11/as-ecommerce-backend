import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { pointsService } from "@/modules/loyalty/club/points.service";
import { newAccessToken } from "@/modules/commerce/orders/orders.service";
import { quotePos, type PosDisc } from "./pos.pricing";
import type { CompleteSaleBody, QuoteBody } from "./pos.schemas";

type Staff = { id: string; name: string; role: string };

async function loadSession(sessionId: string) {
  const s = await prisma.posRegisterSession.findUnique({
    where: { id: sessionId },
    include: { register: { include: { warehouse: true } } },
  });
  if (!s || s.closedAt) throw ApiError.conflict("INVALID_STATE", "Open a register session before selling.");
  return s;
}

async function buildQuote(body: QuoteBody) {
  const pos = await settingsService.get("pos");
  const club = await settingsService.get("club");
  const tax = await settingsService.get("tax");

  const variantIds = body.lines.map((l) => l.variantId);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds }, active: true },
    include: {
      product: { include: { brand: true, images: { orderBy: { position: "asc" }, take: 1 } } },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const l of body.lines) if (!byId.has(l.variantId)) throw ApiError.badRequest("VALIDATION_FAILED", `Unknown variant ${l.variantId}`);

  const customer = body.customerId
    ? await prisma.customer.findFirst({ where: { id: body.customerId, deletedAt: null } })
    : null;
  if (body.customerId && !customer) throw ApiError.notFound("Customer");

  if (pos.requireCustomerOver > 0) {
    // checked after quote totals
  }

  let coupon = null as Awaited<ReturnType<typeof prisma.coupon.findUnique>> | null;
  if (body.couponCode) {
    if (!pos.couponsAtPos) throw ApiError.badRequest("VALIDATION_FAILED", "Coupons are turned off at the till.");
    coupon = await prisma.coupon.findUnique({ where: { code: body.couponCode } });
  }

  const customerPoints = customer ? await pointsService.available(prisma, customer.id) : 0;
  const vatRate = tax.displayPricesIncTax ? 7.5 : 7.5;

  const pricedLines = body.lines.map((l) => {
    const v = byId.get(l.variantId)!;
    const unit = l.unitPrice ?? v.price ?? v.product.price;
    return { qty: l.qty, unitPrice: unit, discount: l.discount as PosDisc | undefined, variant: v };
  });

  const q = quotePos({
    lines: pricedLines.map(({ qty, unitPrice, discount }) => ({ qty, unitPrice, discount })),
    coupon,
    manual: body.manual as PosDisc | undefined,
    pointsToUse: body.pointsToUse,
    pointValueKobo: club.pointValueKobo,
    customerPoints,
    vatRatePct: vatRate,
    redeemLoyalty: pos.redeemLoyaltyAtPos && !!customer,
  });

  if (q.couponError && body.couponCode) throw ApiError.badRequest("VALIDATION_FAILED", q.couponError);
  if (pos.requireCustomerOver > 0 && q.due >= pos.requireCustomerOver && !customer) {
    throw ApiError.badRequest("VALIDATION_FAILED", "Attach a customer for sales this large.");
  }

  return { q, pricedLines, customer, customerPoints, pos, club, coupon };
}

export const posSalesService = {
  async quote(body: QuoteBody) {
    const { q, pricedLines, customer, customerPoints, coupon } = await buildQuote(body);
    return {
      ...q,
      couponCode: coupon?.code ?? null,
      customer: customer
        ? {
            id: customer.id,
            name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
            tier: customer.tier,
            points: customerPoints,
          }
        : null,
      lines: pricedLines.map((l, i) => ({
        variantId: l.variant.id,
        sku: l.variant.sku,
        name: l.variant.product.name,
        brand: l.variant.product.brand.name,
        image: l.variant.product.images[0]?.url ?? null,
        size: l.variant.size,
        color: l.variant.color,
        qty: l.qty,
        unitPrice: l.unitPrice,
        ...q.lines[i],
      })),
    };
  },

  async complete(body: CompleteSaleBody, staff: Staff) {
    if (body.clientKey) {
      const existing = await prisma.order.findUnique({ where: { posClientKey: body.clientKey } });
      if (existing) return this.getSale(existing.id);
    }

    const session = await loadSession(body.registerSessionId);
    const { q, pricedLines, customer, pos, coupon } = await buildQuote(body);

    if (q.due > pos.offlineMaxSale && false) {
      /* online path always allowed; offline limit enforced by till client */
    }

    const paid = body.payments.reduce((a, p) => a + p.amount, 0);
    if (paid < q.due) throw ApiError.badRequest("VALIDATION_FAILED", `Payments are short by ₦${Math.round((q.due - paid) / 100).toLocaleString("en-NG")}.`);
    if (paid - body.change > q.due + body.change) {
      /* allow overpay only as cash change */
    }
    if (body.change > 0 && paid - body.change !== q.due) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Change must equal cash overpayment.");
    }

    const walletPay = body.payments.filter((p) => p.method === "wallet").reduce((a, p) => a + p.amount, 0);
    const pointsPay = body.payments.filter((p) => p.method === "points");
    if (pointsPay.length) {
      // points as tender already applied via pointsToUse in quote; refuse separate points payment lines
      throw ApiError.badRequest("VALIDATION_FAILED", "Redeem points with pointsToUse on the quote, not as a payment line.");
    }

    const order = await prisma.$transaction(async (tx) => {
      const number = formatters.order(await nextSequence(tx, "order", 10249));
      const now = new Date();
      const created = await tx.order.create({
        data: {
          number,
          customerId: customer?.id,
          guestEmail: customer?.email,
          accessToken: newAccessToken(),
          channel: "store",
          status: "delivered",
          paymentStatus: "paid",
          deliveryMethod: "instore",
          paymentMethod: mapPrimaryMethod(body.payments[0].method),
          subtotal: q.subtotal,
          discount: q.discountTotal,
          shipping: 0,
          tax: 0,
          taxIncluded: q.vat,
          walletApplied: walletPay,
          total: q.due,
          amountPaid: q.due,
          couponCode: coupon?.code,
          contact: {
            name: customer ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : "Walk-in",
            email: customer?.email ?? null,
            phone: customer?.phone ?? null,
          },
          pickupLocationId: session.register.locationId,
          registerId: session.registerId,
          registerSessionId: session.id,
          cashierId: staff.id,
          changeGiven: body.change,
          posClientKey: body.clientKey,
          placedAt: now,
          paidAt: now,
          deliveredAt: now,
          items: {
            create: pricedLines.map((l, i) => ({
              productId: l.variant.productId,
              variantId: l.variant.id,
              sku: l.variant.sku,
              name: l.variant.product.name,
              brand: l.variant.product.brand.name,
              imageUrl: l.variant.product.images[0]?.url ?? null,
              size: l.variant.size,
              color: l.variant.color,
              qty: l.qty,
              unitPrice: l.unitPrice,
              lineDiscount: q.lines[i].lineDiscount,
              lineTotal: q.lines[i].net,
              soldById: body.lines[i]?.soldById ?? staff.id,
            })),
          },
          events: {
            create: [
              { type: "placed", title: "In-store sale", detail: `Till ${session.register.name}`, actor: staff.name },
              { type: "payment_confirmed", title: "Paid at till", detail: body.payments.map((p) => `${p.method} ₦${Math.round(p.amount / 100)}`).join(" · "), actor: staff.name },
              { type: "delivered", title: "Handed over in store", actor: staff.name },
            ],
          },
          notes: body.note ? { create: [{ body: body.note, author: staff.name }] } : undefined,
        },
      });

      for (const p of body.payments) {
        await tx.payment.create({
          data: {
            reference: `POS-${created.number}-${p.method}-${Math.random().toString(36).slice(2, 8)}`,
            provider: "pos",
            purpose: "order",
            method: p.method,
            status: "succeeded",
            amount: p.amount,
            customerId: customer?.id,
            email: customer?.email ?? "pos@asloriginals.local",
            orderId: created.id,
            paidAt: now,
            providerData: p.reference ? { reference: p.reference } : undefined,
          },
        });
      }

      await inventoryService.sellAt(
        tx,
        session.register.warehouseId,
        pricedLines.map((l) => ({ variantId: l.variant.id, qty: l.qty })),
        { type: "order", id: created.id },
        staff.name,
      );

      if (customer && walletPay > 0) await walletsService.spend(tx, customer.id, walletPay, number);
      if (customer && q.pointsUsed > 0) {
        await pointsService.lockCustomer(tx, customer.id);
        await pointsService.debit(tx, customer.id, q.pointsUsed, {
          kind: "redemption",
          refId: created.id,
          reason: `Redeemed at till on ${number}`,
          actor: staff.name,
        });
      }

      if (coupon) {
        await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 }, revenue: { increment: BigInt(q.due) } } });
        await tx.couponRedemption.create({
          data: { couponId: coupon.id, code: coupon.code, orderId: created.id, customerId: customer?.id, discount: q.coupon },
        });
      }

      if (customer) {
        await tx.customerStats.upsert({
          where: { customerId: customer.id },
          create: { customerId: customer.id, ordersCount: 1, totalSpend: BigInt(q.due), spend12m: BigInt(q.due), lastOrderAt: now, aov: q.due },
          update: {
            ordersCount: { increment: 1 },
            totalSpend: { increment: BigInt(q.due) },
            spend12m: { increment: BigInt(q.due) },
            lastOrderAt: now,
          },
        });
      }

      await tx.posAuditEvent.create({
        data: {
          locationId: session.register.locationId,
          registerId: session.registerId,
          sessionId: session.id,
          staffId: staff.id,
          approvedById: body.approvedById,
          action: "sale",
          text: `${staff.name} sold ${number} for ₦${Math.round(q.due / 100).toLocaleString("en-NG")}`,
          amount: q.due,
          ref: number,
        },
      });

      await tx.posRegister.update({ where: { id: session.registerId }, data: { lastSeenAt: now, online: true } });
      return created;
    });

    events.emit("order.placed", { orderId: order.id });
    events.emit("order.paid", { orderId: order.id });
    events.emit("order.delivered", { orderId: order.id });

    return this.getSale(order.id);
  },

  async sync(body: { sales: CompleteSaleBody[] }, staff: Staff) {
    const results = [];
    for (const sale of body.sales) {
      results.push(await this.complete(sale, staff));
    }
    return { synced: results.length, orders: results };
  },

  async getSale(id: string) {
    const o = await prisma.order.findFirst({
      where: { OR: [{ id }, { number: id }], channel: "store" },
      include: { items: true, payments: true, customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, tier: true } } },
    });
    if (!o) throw ApiError.notFound("Sale");
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      paymentStatus: o.paymentStatus,
      total: o.total,
      subtotal: o.subtotal,
      discount: o.discount,
      taxIncluded: o.taxIncluded,
      changeGiven: o.changeGiven,
      registerId: o.registerId,
      registerSessionId: o.registerSessionId,
      cashierId: o.cashierId,
      couponCode: o.couponCode,
      placedAt: o.placedAt,
      customer: o.customer
        ? { id: o.customer.id, name: [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" "), email: o.customer.email, phone: o.customer.phone, tier: o.customer.tier }
        : null,
      items: o.items,
      payments: o.payments.map((p) => ({ method: p.method, amount: p.amount, reference: (p.providerData as { reference?: string } | null)?.reference, status: p.status })),
      receiptFooter: (await settingsService.get("pos")).receiptFooter,
    };
  },
};

function mapPrimaryMethod(m: string): "card" | "bank_transfer" | "paystack" | "wallet" {
  if (m === "wallet") return "wallet";
  if (m === "transfer") return "bank_transfer";
  return "card";
}
