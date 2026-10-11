/**
 * Checkout = the saved choices for one bag (so web and app resume on the same step)
 * + a calculator. Totals are ALWAYS recomputed on the server at place-order; what the
 * client shows is only a preview.
 */
import type { CheckoutSession, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { nextSequence, formatters } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { addressesService } from "@/modules/platform/addresses/addresses.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { shippingZonesService, countryCode } from "@/modules/fulfilment/shipping-zones/shipping-zones.service";
import { pickupsService } from "@/modules/fulfilment/pickups/pickups.service";
import { taxService } from "@/modules/fulfilment/tax/tax.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { couponsService, type CouponChannel, type PricedLine } from "@/modules/commerce/coupons/coupons.service";
import { cartsService, type CartOwner } from "@/modules/commerce/carts/carts.service";
import { toCartView, type CartRow } from "@/modules/commerce/carts/cart.mapper";
import { ordersService, newAccessToken } from "@/modules/commerce/orders/orders.service";
import type { CheckoutAddress, CheckoutContact, PlaceOrderBody, UpdateCheckoutBody } from "./checkout.schemas";

const couponChannel = (c: string): CouponChannel => (c === "mobile" ? "mobile" : "web");

async function requireCart(o: CartOwner) {
  const cart = await cartsService.find(o);
  if (!cart || !cart.items.length) throw ApiError.badRequest("VALIDATION_FAILED", "Your bag is empty.");
  return cart;
}

async function sessionFor(cart: CartRow, customerId?: string) {
  const existing = await prisma.checkoutSession.findUnique({ where: { cartId: cart.id } });
  if (existing) return existing;
  // first visit: prefill from the account (default address, email, phone)
  let contact: CheckoutContact | null = null;
  let address: CheckoutAddress | null = null;
  if (customerId) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true, phone: true, marketingOptIn: true } });
    contact = { email: c.email, phone: c.phone ?? "", subscribe: c.marketingOptIn };
    const a = await addressesService.defaultFor(customerId);
    if (a) address = { fullName: a.recipient, address: a.line1, apartment: a.line2 ?? "", city: a.city, state: a.state, postal: a.postalCode ?? "", country: a.country, phone: a.phone };
  }
  return prisma.checkoutSession.create({
    data: { cartId: cart.id, customerId: customerId ?? null, contact: contact ?? undefined, address: address ?? undefined, paymentMethod: "paystack" },
  });
}

function pricedLines(cart: CartRow): PricedLine[] {
  return cart.items.map((i) => {
    const v = i.product.variants.find((x) => x.id === i.variantId);
    return {
      productId: i.productId,
      categoryHandle: i.product.category.handle,
      subcategoryHandle: i.product.subcategory?.handle ?? null,
      brandHandle: i.product.brand.handle,
      unitPrice: v?.price ?? i.product.price,
      qty: i.qty,
    };
  });
}

/** Everything the order summary shows. Pure calculation — nothing is written. */
async function compute(cart: CartRow, s: CheckoutSession, customerId?: string) {
  const shippingSettings = await settingsService.get("shipping");
  const view = toCartView(cart, { freeShippingThreshold: shippingSettings.freeShippingThreshold });
  const lines = pricedLines(cart).filter((_, idx) => !["unavailable", "sold_out"].includes(view.items[idx].issue ?? ""));
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  const address = s.address as CheckoutAddress | null;
  const contact = s.contact as CheckoutContact | null;

  // delivery
  let shipping: number | null = 0;
  let shippingOption: { id: string; name: string; carrier: string; eta: string; fee: number } | null = null;
  let shippingOptions: Awaited<ReturnType<typeof shippingZonesService.quote>>["options"] = [];
  if (s.delivery === "ship") {
    if (!address) shipping = null;
    else {
      const weightKg = cart.items.reduce((n, i) => n + ((i.product.weightGrams ?? 1000) * i.qty) / 1000, 0);
      const q = await shippingZonesService.quote({ country: countryCode(address.country), state: address.state, city: address.city, postcode: address.postal, subtotal, weightKg });
      shippingOptions = q.options;
      const opt = q.options.find((o) => o.id === s.shippingRateId) ?? q.options[0] ?? null;
      shippingOption = opt ? { id: opt.id, name: opt.name, carrier: opt.carrier, eta: opt.eta, fee: opt.fee } : null;
      shipping = opt ? opt.fee : null;
    }
  }

  // coupons (typed code + auto-apply)
  const coupons = await couponsService.resolve(
    { customerId: customerId ?? null, channel: couponChannel(cart.channel), lines, subtotal, shipping: shipping ?? 0 },
    s.couponCode,
  );
  if (coupons.freeShipping && shipping) shipping = 0;
  const discount = coupons.discount;

  // tax (VAT is inside the price by default → reported, not added)
  const tax = await taxService.compute({
    country: address ? countryCode(address.country) : "NG", state: address?.state, postcode: address?.postal,
    productsAmount: subtotal - discount, shippingAmount: shipping ?? 0, customerEmail: contact?.email,
  });
  const total = subtotal - discount + (shipping ?? 0) + tax.added;

  // wallet
  let walletBalance = 0;
  let walletApplied = 0;
  if (customerId) {
    const w = await walletsService.balanceOf(customerId);
    walletBalance = w.frozen ? 0 : w.balance;
    if (s.useWallet || s.paymentMethod === "wallet") walletApplied = Math.min(walletBalance, total);
  }

  return {
    view,
    lines,
    shippingOptions,
    totals: {
      currency: "NGN",
      itemsCount: view.items.reduce((n, i) => n + (i.issue === "sold_out" || i.issue === "unavailable" ? 0 : i.qty), 0),
      subtotal,
      discount,
      coupons: coupons.applied.map((a) => ({ code: a.code, title: a.title, discount: a.discount, freeShipping: a.freeShipping })),
      couponError: coupons.error ? { code: coupons.error.code, message: coupons.error.message } : null,
      shipping,
      shippingOption,
      tax: { included: tax.included, added: tax.added, lines: tax.lines },
      total,
      walletBalance,
      walletApplied,
      due: total - walletApplied,
    },
    applied: coupons.applied,
  };
}

async function snapshot(o: CartOwner, customerId?: string) {
  const cart = await cartsService.find(o);
  if (!cart || !cart.items.length) return { empty: true as const, cart: toCartView(cart, { freeShippingThreshold: (await settingsService.get("shipping")).freeShippingThreshold }) };
  const s = await sessionFor(cart, customerId);
  const c = await compute(cart, s, customerId);
  const settings = await settingsService.get("checkout");
  return {
    empty: false as const,
    cart: c.view,
    session: {
      contact: s.contact, delivery: s.delivery, address: s.address, pickupLocationId: s.pickupLocationId, shippingRateId: s.shippingRateId,
      paymentMethod: s.paymentMethod, couponCode: s.couponCode, useWallet: s.useWallet, giftMessage: s.giftMessage,
    },
    shippingOptions: c.shippingOptions,
    pickupLocations: await pickupsService.storeLocations(),
    totals: c.totals,
    rules: { guestCheckout: settings.guestCheckout, requirePhone: settings.requirePhone, askGiftMessage: settings.askGiftMessage, minOrderValue: settings.minOrderValue },
  };
}

export const checkoutService = {
  get: snapshot,

  async update(o: CartOwner, customerId: string | undefined, b: UpdateCheckoutBody) {
    const cart = await requireCart(o);
    const s = await sessionFor(cart, customerId);
    const data: Prisma.CheckoutSessionUpdateInput = {};
    if (b.contact) data.contact = b.contact;
    if (b.delivery) data.delivery = b.delivery;
    if (b.address !== undefined) data.address = b.address ?? undefined;
    if (b.savedAddressId) {
      if (!customerId) throw ApiError.unauthenticated();
      const a = await addressesService.get(customerId, b.savedAddressId);
      data.address = { fullName: a.recipient, address: a.line1, apartment: a.line2 ?? "", city: a.city, state: a.state, postal: a.postalCode ?? "", country: a.country, phone: a.phone };
    }
    if (b.pickupLocationId !== undefined) {
      if (b.pickupLocationId) await pickupsService.activeLocation(b.pickupLocationId);
      data.pickupLocationId = b.pickupLocationId;
    }
    if (b.shippingRateId !== undefined) data.shippingRateId = b.shippingRateId;
    if (b.paymentMethod) {
      if (b.paymentMethod === "wallet" && !customerId) throw ApiError.unauthenticated("Sign in to pay with your wallet.");
      data.paymentMethod = b.paymentMethod;
    }
    if (b.useWallet !== undefined) {
      if (b.useWallet && !customerId) throw ApiError.unauthenticated("Sign in to use your wallet.");
      data.useWallet = b.useWallet;
    }
    if (b.giftMessage !== undefined) data.giftMessage = b.giftMessage;
    await prisma.checkoutSession.update({ where: { id: s.id }, data });
    if (b.contact?.email) await prisma.cart.update({ where: { id: cart.id }, data: { email: b.contact.email } });
    return snapshot(o, customerId);
  },

  /** "Apply" button: validates now and returns the message the UI shows */
  async applyCoupon(o: CartOwner, customerId: string | undefined, code: string) {
    const cart = await requireCart(o);
    const s = await sessionFor(cart, customerId);
    const c = await compute(cart, s, customerId);
    // throws COUPON_* with the reason (expired, min spend, not eligible …)
    const applied = await couponsService.evaluate(code, { customerId, channel: couponChannel(cart.channel), lines: c.lines, subtotal: c.totals.subtotal, shipping: c.totals.shipping ?? 0 });
    await prisma.checkoutSession.update({ where: { id: s.id }, data: { couponCode: applied.code } });
    const message = applied.freeShipping ? "Free shipping applied" : `${formatNaira(applied.discount)} off applied`;
    return { message, coupon: { code: applied.code, title: applied.title, discount: applied.discount }, checkout: await snapshot(o, customerId) };
  },

  async removeCoupon(o: CartOwner, customerId?: string) {
    const cart = await requireCart(o);
    await prisma.checkoutSession.updateMany({ where: { cartId: cart.id }, data: { couponCode: null } });
    return snapshot(o, customerId);
  },

  /** Review → Place order. Requires Idempotency-Key. */
  async placeOrder(o: CartOwner, customerId: string | undefined, b: PlaceOrderBody) {
    const settings = await settingsService.get("checkout");
    if (!customerId && !settings.guestCheckout) throw ApiError.unauthenticated("Please sign in or create an account to place your order.");
    const cart = await requireCart(o);
    const s = await sessionFor(cart, customerId);
    const contact = s.contact as CheckoutContact | null;
    const address = s.address as CheckoutAddress | null;

    // ── validate the choices ──
    if (!contact?.email) throw ApiError.badRequest("VALIDATION_FAILED", "Add your email address.", { step: "information" });
    if (settings.requirePhone && !(contact.phone || address?.phone)) throw ApiError.badRequest("VALIDATION_FAILED", "Add a phone number so the courier can reach you.", { step: "information" });
    if (s.delivery === "ship" && !address) throw ApiError.badRequest("VALIDATION_FAILED", "Add a delivery address.", { step: "information" });
    if (s.delivery === "pickup") {
      if (!s.pickupLocationId) throw ApiError.badRequest("VALIDATION_FAILED", "Choose a pick-up store.", { step: "information" });
      await pickupsService.activeLocation(s.pickupLocationId);
    }
    const c = await compute(cart, s, customerId);
    const bad = c.view.items.filter((i) => i.issue && i.issue !== "low_stock");
    if (bad.length) throw ApiError.conflict("OUT_OF_STOCK", "Some items in your bag are no longer available. Remove them to continue.", { items: bad.map((i) => ({ id: i.id, name: i.name, issue: i.issue })) });
    if (s.couponCode && c.totals.couponError) throw ApiError.badRequest(c.totals.couponError.code as "COUPON_INVALID", c.totals.couponError.message, { step: "payment" });
    if (s.delivery === "ship" && (c.totals.shipping === null || !c.totals.shippingOption))
      throw ApiError.badRequest("VALIDATION_FAILED", "We don't deliver to this address yet. Choose pick-up in store or contact support.", { step: "information" });
    if (c.totals.total < settings.minOrderValue) throw ApiError.badRequest("VALIDATION_FAILED", `Minimum order is ${formatNaira(settings.minOrderValue)}.`);
    if (c.totals.total > settings.maxOrderValue) throw ApiError.badRequest("VALIDATION_FAILED", `Orders above ${formatNaira(settings.maxOrderValue)} are handled by our concierge team. Please contact us.`);
    if (b.expectedTotal !== undefined && b.expectedTotal !== c.totals.total)
      throw ApiError.conflict("CONFLICT", "Prices or delivery changed since you last looked. Please review your order.", { totals: c.totals });
    if (s.paymentMethod === "wallet" && c.totals.due > 0)
      throw ApiError.badRequest("INSUFFICIENT_WALLET_BALANCE", `Your wallet covers ${formatNaira(c.totals.walletApplied)}. Choose another method for the remaining ${formatNaira(c.totals.due)}.`, { step: "payment" });

    const email = contact.email.toLowerCase();
    const t = c.totals;
    const placed = await prisma.$transaction(async (tx) => {
      const number = formatters.order(await nextSequence(tx, "order", 10249));
      const order = await tx.order.create({
        data: {
          number,
          customerId: customerId ?? null,
          guestEmail: customerId ? null : email,
          accessToken: newAccessToken(),
          channel: cart.channel,
          deliveryMethod: s.delivery,
          paymentMethod: t.due === 0 ? "wallet" : s.paymentMethod === "wallet" ? "card" : s.paymentMethod,
          subtotal: t.subtotal, discount: t.discount, shipping: t.shipping ?? 0, tax: t.tax.added, walletApplied: t.walletApplied, total: t.total,
          amountPaid: t.walletApplied,
          paymentStatus: t.walletApplied ? (t.due === 0 ? "paid" : "partially_paid") : "unpaid",
          couponCode: t.coupons.map((x) => x.code).join(",") || null,
          contact: { ...contact, email },
          shippingAddress: s.delivery === "ship" ? (address as object) : undefined,
          pickupLocationId: s.delivery === "pickup" ? s.pickupLocationId : null,
          shippingRateName: t.shippingOption?.name ?? null,
          giftMessage: s.giftMessage,
          items: {
            create: c.view.items
              .filter((i) => !i.issue || i.issue === "low_stock")
              .map((i) => {
                const row = cart.items.find((x) => x.id === i.id)!;
                const variant = row.product.variants.find((v) => v.id === row.variantId);
                return {
                  productId: row.productId, variantId: row.variantId, sku: variant?.sku, name: i.name, brand: i.brand, imageUrl: i.image,
                  size: i.size, color: i.color, qty: i.qty, unitPrice: i.price, lineTotal: i.lineTotal,
                };
              }),
          },
        },
        include: { items: true },
      });
      await ordersService.addEvent(tx, order.id, "placed", "Order placed", { detail: `${order.items.length} item(s) · ${formatNaira(order.total)}` });

      // stock (pre-order items are made to order, so nothing to hold)
      const preOrder = new Set(cart.items.filter((i) => i.product.availability === "pre_order").map((i) => i.variantId));
      const stockLines = order.items.filter((i) => i.variantId && !preOrder.has(i.variantId)).map((i) => ({ variantId: i.variantId!, qty: i.qty }));
      await inventoryService.reserve(tx, stockLines, ordersService.STOCK_REF(order.id));

      await couponsService.redeem(tx, c.applied, order.id, customerId ?? null);
      if (t.walletApplied && customerId) await walletsService.spend(tx, customerId, t.walletApplied, number);
      if (customerId && address && s.delivery === "ship") await addressesService.rememberFromCheckout(tx, customerId, { ...address, phone: address.phone || contact.phone });
      if (customerId && contact.subscribe) await tx.customer.update({ where: { id: customerId }, data: { marketingOptIn: true } });
      await cartsService.markConverted(tx, cart.id);

      let paidOrderId: string | null = null;
      let paymentRef: string | null = null;
      if (t.due === 0) {
        // wallet covered everything: amountPaid is already the total → mark paid now
        await tx.order.update({ where: { id: order.id }, data: { amountPaid: 0 } });
        paidOrderId = await ordersService.applyPayment(tx, order.id, t.total, "ASL Wallet");
      } else {
        const p = await paymentsService.createRecord(tx, {
          purpose: "order", amount: t.due, email, customerId: customerId ?? null, orderId: order.id,
          method: s.paymentMethod === "bank_transfer" ? "bank_transfer" : "card", returnUrl: b.returnUrl, savedMethodId: b.savedMethodId, saveCard: b.saveCard && !!customerId,
        });
        paymentRef = p.reference;
      }
      return { order, paidOrderId, paymentRef };
    });

    events.emit("order.placed", { orderId: placed.order.id });
    ordersService.afterPaid(placed.paidOrderId);
    const payment = placed.paymentRef ? await paymentsService.begin(placed.paymentRef) : null;
    return {
      order: { id: placed.order.id, number: placed.order.number, total: placed.order.total, accessToken: placed.order.accessToken, status: payment?.status === "succeeded" || placed.paidOrderId ? "paid" : "pending_payment" },
      payment,
    };
  },
};
