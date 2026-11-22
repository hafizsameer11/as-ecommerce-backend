import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { pointsService } from "@/modules/loyalty/club/points.service";
import { newAccessToken, ordersService } from "@/modules/commerce/orders/orders.service";
import { shippingZonesService, countryCode } from "@/modules/fulfilment/shipping-zones/shipping-zones.service";
import { quotePos, type PosDisc } from "./pos.pricing";
import { posGiftCardsService } from "./pos.giftcards.service";
import { posPromotionsService } from "./pos.promotions.service";
import type { AdvanceShipBody, CompleteSaleBody, QuoteBody, SalesListQuery, ShippingQuoteBody } from "./pos.schemas";
import { WEB_CHANNELS } from "./pos.schemas";

type Staff = { id: string; name: string; role: string };

async function loadSession(sessionId: string) {
  const s = await prisma.posRegisterSession.findUnique({
    where: { id: sessionId },
    include: { register: { include: { warehouse: true } } },
  });
  if (!s || s.closedAt) throw ApiError.conflict("INVALID_STATE", "Open a register session before selling.");
  return s;
}

async function buildQuote(body: QuoteBody & { extras?: CompleteSaleBody["extras"]; fulfilment?: CompleteSaleBody["fulfilment"]; shippingAddress?: CompleteSaleBody["shippingAddress"]; shippingRateId?: string; deposit?: number; locationId?: string }) {
  const pos = await settingsService.get("pos");
  const club = await settingsService.get("club");
  const tax = await settingsService.get("tax");

  const variantIds = body.lines.map((l) => l.variantId);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds }, active: true },
    include: {
      product: { include: { brand: true, category: true, images: { orderBy: { position: "asc" }, take: 1 } } },
    },
  });
  const byId = new Map(variants.map((v) => [v.id, v]));
  for (const l of body.lines) if (!byId.has(l.variantId)) throw ApiError.badRequest("VALIDATION_FAILED", `Unknown variant ${l.variantId}`);

  const customer = body.customerId
    ? await prisma.customer.findFirst({ where: { id: body.customerId, deletedAt: null } })
    : null;
  if (body.customerId && !customer) throw ApiError.notFound("Customer");

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
    return {
      qty: l.qty,
      unitPrice: unit,
      discount: l.discount as PosDisc | undefined,
      category: v.product.category.handle,
      brand: v.product.brand.handle,
      variant: v,
    };
  });

  const promos =
    pos.autoPromosEnabled
      ? (await posPromotionsService.listActive(body.locationId)).map((p) => posPromotionsService.toPromo(p))
      : [];

  const birthdayMonth =
    !!customer?.dateOfBirth && customer.dateOfBirth.getUTCMonth() === new Date().getUTCMonth();

  let deliveryFee = 0;
  let shippingOption: { id: string; name: string; fee: number } | null = null;
  if (body.fulfilment === "ship" && body.shippingAddress) {
    const addr = body.shippingAddress;
    const goodsSub = pricedLines.reduce((a, l) => a + l.qty * l.unitPrice, 0);
    const q = await shippingZonesService.quote({
      country: countryCode(addr.country),
      state: addr.state,
      city: addr.city,
      postcode: addr.postal,
      subtotal: goodsSub,
      weightKg: 1,
    });
    const opt = q.options.find((o) => o.id === body.shippingRateId) ?? q.options[0] ?? null;
    if (!opt) throw ApiError.badRequest("VALIDATION_FAILED", "We don't deliver to this address yet.");
    shippingOption = { id: opt.id, name: opt.name, fee: opt.fee };
    deliveryFee = opt.fee;
  }

  const extrasList = [...(body.extras ?? [])];
  if (deliveryFee > 0 && !extrasList.some((e) => e.kind === "delivery")) {
    extrasList.push({ kind: "delivery", label: shippingOption?.name ?? "Delivery", amount: deliveryFee });
  }
  const extrasTotal = extrasList.reduce((a, e) => a + e.amount, 0);

  const q = quotePos({
    lines: pricedLines.map(({ qty, unitPrice, discount, category, brand }) => ({ qty, unitPrice, discount, category, brand })),
    coupon,
    manual: body.manual as PosDisc | undefined,
    pointsToUse: body.pointsToUse,
    pointValueKobo: club.pointValueKobo,
    customerPoints,
    vatRatePct: vatRate,
    redeemLoyalty: pos.redeemLoyaltyAtPos && !!customer,
    promos,
    birthdayMonth,
    extras: extrasTotal,
  });

  if (q.couponError && body.couponCode) throw ApiError.badRequest("VALIDATION_FAILED", q.couponError);
  if (pos.requireCustomerOver > 0 && q.due >= pos.requireCustomerOver && !customer) {
    throw ApiError.badRequest("VALIDATION_FAILED", "Attach a customer for sales this large.");
  }

  let depositDue: number | null = null;
  if (body.fulfilment === "layaway") {
    if (!pos.layawayEnabled) throw ApiError.badRequest("VALIDATION_FAILED", "Layaway is turned off.");
    if (!customer) throw ApiError.badRequest("VALIDATION_FAILED", "Layaway needs a customer.");
    const min = Math.ceil((q.due * pos.layawayMinDepositPct) / 100);
    depositDue = body.deposit != null ? body.deposit : min;
    if (depositDue < min) {
      throw ApiError.badRequest("VALIDATION_FAILED", `Deposit must be at least ${pos.layawayMinDepositPct}% (₦${Math.round(min / 100).toLocaleString("en-NG")}).`);
    }
    if (depositDue > q.due) depositDue = q.due;
  }

  return { q, pricedLines, customer, customerPoints, pos, club, coupon, extrasList, shippingOption, depositDue };
}

export const posSalesService = {
  async quote(body: QuoteBody & Partial<CompleteSaleBody>, locationId?: string) {
    const { q, pricedLines, customer, customerPoints, coupon, extrasList, shippingOption, depositDue, pos } =
      await buildQuote({ ...body, locationId });
    return {
      ...q,
      couponCode: coupon?.code ?? null,
      extras: extrasList,
      shipping: shippingOption,
      depositDue,
      layawayMinDepositPct: pos.layawayMinDepositPct,
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

  async shippingOptions(body: ShippingQuoteBody) {
    return shippingZonesService.quote({
      country: countryCode(body.address.country),
      state: body.address.state,
      city: body.address.city,
      postcode: body.address.postal,
      subtotal: body.subtotal,
      weightKg: body.weightKg ?? 1,
    });
  },

  async complete(body: CompleteSaleBody, staff: Staff) {
    if (body.clientKey) {
      const existing = await prisma.order.findUnique({ where: { posClientKey: body.clientKey } });
      if (existing) return this.getSale(existing.id);
    }

    const session = await loadSession(body.registerSessionId);
    const { q, pricedLines, customer, pos, coupon, extrasList, shippingOption, depositDue } = await buildQuote({
      ...body,
      locationId: session.register.locationId,
    });

    const dueNow = body.fulfilment === "layaway" ? depositDue! : q.due;
    const paid = body.payments.reduce((a, p) => a + p.amount, 0);
    if (paid < dueNow) {
      throw ApiError.badRequest("VALIDATION_FAILED", `Payments are short by ₦${Math.round((dueNow - paid) / 100).toLocaleString("en-NG")}.`);
    }
    if (body.change > 0 && paid - body.change !== dueNow) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Change must equal cash overpayment.");
    }

    const walletPay = body.payments.filter((p) => p.method === "wallet").reduce((a, p) => a + p.amount, 0);
    if (body.payments.some((p) => p.method === "points")) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Redeem points with pointsToUse on the quote, not as a payment line.");
    }
    for (const p of body.payments.filter((x) => x.method === "giftcard")) {
      if (!pos.giftCardsEnabled) throw ApiError.badRequest("VALIDATION_FAILED", "Gift cards are turned off.");
      if (!p.reference) throw ApiError.badRequest("VALIDATION_FAILED", "Gift card code required.");
    }

    if (body.fulfilment === "ship" && !body.shippingAddress) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Shipping address is required.");
    }

    const fulfilment = body.fulfilment ?? "instore";
    const isLayaway = fulfilment === "layaway";
    const isShip = fulfilment === "ship";

    const order = await prisma.$transaction(async (tx) => {
      const number = formatters.order(await nextSequence(tx, "order", 10249));
      const now = new Date();
      const shipping = shippingOption?.fee ?? 0;

      const created = await tx.order.create({
        data: {
          number,
          customerId: customer?.id,
          guestEmail: customer?.email,
          accessToken: newAccessToken(),
          channel: "store",
          status: isLayaway ? "pending_payment" : isShip ? "processing" : "delivered",
          paymentStatus: isLayaway ? "partially_paid" : "paid",
          deliveryMethod: isShip ? "ship" : "instore",
          paymentMethod: mapPrimaryMethod(body.payments[0].method),
          subtotal: q.subtotal,
          discount: q.discountTotal,
          shipping,
          tax: 0,
          taxIncluded: q.vat,
          walletApplied: walletPay,
          total: q.due,
          amountPaid: dueNow,
          couponCode: coupon?.code,
          contact: {
            name: customer ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") : body.shippingAddress?.fullName ?? "Walk-in",
            email: customer?.email ?? null,
            phone: customer?.phone ?? body.shippingAddress?.phone ?? null,
          },
          shippingAddress: body.shippingAddress
            ? ({
                fullName: body.shippingAddress.fullName,
                address: body.shippingAddress.address,
                apartment: body.shippingAddress.apartment,
                city: body.shippingAddress.city,
                state: body.shippingAddress.state,
                postal: body.shippingAddress.postal,
                country: body.shippingAddress.country,
                phone: body.shippingAddress.phone,
              } as Prisma.InputJsonValue)
            : undefined,
          shippingRateName: shippingOption?.name,
          pickupLocationId: session.register.locationId,
          registerId: session.registerId,
          registerSessionId: session.id,
          cashierId: staff.id,
          changeGiven: body.change,
          posClientKey: body.clientKey,
          placedAt: now,
          paidAt: isLayaway ? null : now,
          deliveredAt: fulfilment === "instore" ? now : null,
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
              {
                type: "placed",
                title: isLayaway ? "Layaway opened" : isShip ? "Ship-from-till order" : "In-store sale",
                detail: `Till ${session.register.name}`,
                actor: staff.name,
              },
              {
                type: "payment_confirmed",
                title: isLayaway ? "Deposit taken" : "Paid at till",
                detail: body.payments.map((p) => `${p.method} ₦${Math.round(p.amount / 100)}`).join(" · "),
                actor: staff.name,
              },
              ...(fulfilment === "instore"
                ? [{ type: "delivered", title: "Handed over in store", actor: staff.name }]
                : []),
            ],
          },
          notes: body.note ? { create: [{ body: body.note, author: staff.name }] } : undefined,
        },
      });

      for (const p of body.payments) {
        if (p.method === "giftcard") {
          await posGiftCardsService.redeem(p.reference!, p.amount, number, staff.id);
        }
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

      const stockLines = pricedLines.map((l) => ({ variantId: l.variant.id, qty: l.qty }));
      if (isLayaway) {
        await inventoryService.reserveAt(tx, session.register.warehouseId, stockLines, { type: "order", id: created.id }, staff.name);
      } else {
        // instore handoff + ship-from-till both leave boutique stock immediately
        await inventoryService.sellAt(tx, session.register.warehouseId, stockLines, { type: "order", id: created.id }, staff.name);
      }

      if (isLayaway) {
        const until = new Date(Date.now() + pos.layawayHoldDays * 86_400_000);
        await tx.posLayaway.create({
          data: {
            orderId: created.id,
            deposit: dueNow,
            balance: q.due - dueNow,
            until,
            status: "open",
          },
        });
      }

      for (const extra of extrasList.filter((e) => e.kind === "giftcard" && e.amount > 0)) {
        await posGiftCardsService.issue(
          { amount: extra.amount, customerId: customer?.id, locationId: session.register.locationId, orderId: created.id },
          staff.id,
        );
      }

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
        await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 }, revenue: { increment: BigInt(dueNow) } } });
        await tx.couponRedemption.create({
          data: { couponId: coupon.id, code: coupon.code, orderId: created.id, customerId: customer?.id, discount: q.coupon },
        });
      }

      if (customer && !isLayaway) {
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
          action: isLayaway ? "reservation" : "sale",
          text: `${staff.name} ${isLayaway ? "opened layaway" : "sold"} ${number} for ₦${Math.round(dueNow / 100).toLocaleString("en-NG")}`,
          amount: dueNow,
          ref: number,
        },
      });

      await tx.posRegister.update({ where: { id: session.registerId }, data: { lastSeenAt: now, online: true } });
      return created;
    });

    events.emit("order.placed", { orderId: order.id });
    if (!isLayaway) events.emit("order.paid", { orderId: order.id });
    if (fulfilment === "instore") events.emit("order.delivered", { orderId: order.id });

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
    const layaway = await prisma.posLayaway.findUnique({ where: { orderId: o.id } });
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      paymentStatus: o.paymentStatus,
      total: o.total,
      subtotal: o.subtotal,
      discount: o.discount,
      shipping: o.shipping,
      taxIncluded: o.taxIncluded,
      changeGiven: o.changeGiven,
      registerId: o.registerId,
      registerSessionId: o.registerSessionId,
      cashierId: o.cashierId,
      couponCode: o.couponCode,
      deliveryMethod: o.deliveryMethod,
      shippingAddress: o.shippingAddress,
      shippingRateName: o.shippingRateName,
      locationId: o.pickupLocationId,
      expectedDeliveryAt: o.expectedDeliveryAt,
      placedAt: o.placedAt,
      layaway,
      customer: o.customer
        ? { id: o.customer.id, name: [o.customer.firstName, o.customer.lastName].filter(Boolean).join(" "), email: o.customer.email, phone: o.customer.phone, tier: o.customer.tier }
        : null,
      items: o.items,
      payments: o.payments.map((p) => ({ method: p.method, amount: p.amount, reference: (p.providerData as { reference?: string } | null)?.reference, status: p.status })),
      receiptFooter: (await settingsService.get("pos")).receiptFooter,
    };
  },

  async listSales(q: SalesListQuery) {
    const channelFilter = q.channel ?? "store";
    const location = q.locationId ? { pickupLocationId: q.locationId } : {};
    const channelWhere: Prisma.OrderWhereInput =
      channelFilter === "web"
        ? { channel: { in: [...WEB_CHANNELS] }, ...location }
        : channelFilter === "all" && q.locationId
          ? {
              OR: [
                { channel: "store", pickupLocationId: q.locationId },
                { channel: { in: [...WEB_CHANNELS] }, pickupLocationId: q.locationId },
              ],
            }
          : { channel: "store", ...location };

    const where: Prisma.OrderWhereInput = {
      ...channelWhere,
      ...(q.fulfilment === "ship"
        ? { deliveryMethod: "ship" }
        : q.fulfilment === "instore"
          ? { deliveryMethod: "instore" }
          : {}),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q } },
              { customer: { OR: [{ firstName: { contains: q.q } }, { lastName: { contains: q.q } }, { phone: { contains: q.q } }] } },
            ],
          }
        : {}),
    };

    let [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: true,
          payments: true,
          customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
        },
        orderBy: { placedAt: "desc" },
        ...paging(q),
      }),
      prisma.order.count({ where }),
    ]);

    const layaways = await prisma.posLayaway.findMany({ where: { orderId: { in: rows.map((r) => r.id) } } });
    const layByOrder = new Map(layaways.map((l) => [l.orderId, l]));
    if (q.fulfilment === "layaway") {
      rows = rows.filter((r) => layByOrder.has(r.id));
      total = rows.length;
    }

    return withMeta(
      rows.map((o) => ({
        id: o.id,
        number: o.number,
        channel: o.channel,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: o.total,
        subtotal: o.subtotal,
        discount: o.discount,
        shipping: o.shipping,
        taxIncluded: o.taxIncluded,
        changeGiven: o.changeGiven,
        amountPaid: o.amountPaid,
        deliveryMethod: o.deliveryMethod,
        registerId: o.registerId,
        cashierId: o.cashierId,
        locationId: o.pickupLocationId,
        shippingAddress: o.shippingAddress,
        shippingRateName: o.shippingRateName,
        expectedDeliveryAt: o.expectedDeliveryAt,
        placedAt: o.placedAt,
        customer: o.customer
          ? { id: o.customer.id, name: `${o.customer.firstName} ${o.customer.lastName}`.trim(), email: o.customer.email, phone: o.customer.phone }
          : null,
        payments: o.payments.map((p) => ({ method: p.method, amount: p.amount, reference: (p.providerData as { reference?: string } | null)?.reference })),
        items: o.items,
        layaway: layByOrder.get(o.id) ?? null,
      })),
      pageMeta(q, total),
    );
  },

  async advanceShip(id: string, body: AdvanceShipBody, staff: Staff) {
    const o = await prisma.order.findFirst({ where: { OR: [{ id }, { number: id }], channel: "store", deliveryMethod: "ship" } });
    if (!o) throw ApiError.notFound("Sale");
    const to = body.status as OrderStatus;
    await ordersService.setStatus(o.id, to, staff.name);
    return this.getSale(o.id);
  },
};

function mapPrimaryMethod(m: string): "card" | "bank_transfer" | "paystack" | "wallet" {
  if (m === "wallet") return "wallet";
  if (m === "transfer") return "bank_transfer";
  return "card";
}
