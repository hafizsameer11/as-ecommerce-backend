/**
 * Shopping bag. A cart belongs to a signed-in customer, or to a guest identified by
 * an opaque token the client keeps (header `X-Cart-Token`). Prices are re-read from the
 * catalogue on every read, so the bag always shows today's price and stock.
 */
import crypto from "node:crypto";
import { prisma, type Db } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { productInclude, type ProductRow } from "@/modules/catalog/products/product.mapper";
import { toCartView, type CartRow, cartInclude } from "./cart.mapper";

export const MAX_LINE_QTY = 10;

export type CartOwner = { customerId?: string; guestToken?: string };

/** an abandoned bag is still the customer's bag (reminder link / returning customer) */
const OPEN = { in: ["active" as const, "abandoned" as const] };
const ownerWhere = (o: CartOwner) =>
  o.customerId ? { customerId: o.customerId, status: OPEN } : { guestToken: o.guestToken!, status: OPEN };

async function find(o: CartOwner, db: Db = prisma): Promise<CartRow | null> {
  if (!o.customerId && !o.guestToken) return null;
  return db.cart.findFirst({ where: ownerWhere(o), include: cartInclude, orderBy: { updatedAt: "desc" } });
}

async function findOrCreate(o: CartOwner, channel: "web" | "mobile" | "pwa" = "web") {
  const existing = await find(o);
  if (existing) return existing;
  return prisma.cart.create({
    data: o.customerId ? { customerId: o.customerId, channel } : { guestToken: newGuestToken(), channel },
    include: cartInclude,
  });
}

export const newGuestToken = () => crypto.randomBytes(24).toString("base64url");

/** stock still free for a variant */
const free = (v: ProductRow["variants"][number]) => v.stock.reduce((n, s) => n + Math.max(0, s.onHand - s.reserved), 0);

/** Find the exact variant for a size/colour choice (colour only matters when the product sells several). */
export function pickVariant(p: ProductRow, size?: string | null, color?: string | null) {
  const sized = p.variants.some((v) => v.size);
  const coloured = p.variants.some((v) => v.color);
  if (sized && !size) throw ApiError.badRequest("VALIDATION_FAILED", "Please choose a size.");
  if (coloured && !color) throw ApiError.badRequest("VALIDATION_FAILED", "Please choose a colour.");
  const v = p.variants.find((x) => (!sized || x.size === size) && (!coloured || x.color === color));
  if (!v) throw ApiError.badRequest("VALIDATION_FAILED", "That size / colour is not available for this product.");
  return v;
}

/** Validates that a product can go in the bag and returns variant + unit price. */
export function assertSellable(p: ProductRow, size: string | null | undefined, color: string | null | undefined, qty: number) {
  if (p.status !== "active") throw ApiError.badRequest("VALIDATION_FAILED", "This product is no longer available.");
  if (p.priceOnRequest || p.isConcierge)
    throw ApiError.badRequest("VALIDATION_FAILED", "This item is sourced on request. Send a concierge request instead.");
  if (p.drop && p.drop.status !== "ended" && p.drop.releaseAt > new Date())
    throw ApiError.badRequest("DROP_NOT_OPEN", "This item is not released yet. Reserve it from the drop page.");
  const variant = pickVariant(p, size, color);
  if (p.availability !== "pre_order" && free(variant) < qty)
    throw ApiError.conflict("OUT_OF_STOCK", free(variant) ? `Only ${free(variant)} left in this size.` : "This size is sold out.", {
      available: free(variant),
    });
  return { variant, unitPrice: variant.price ?? p.price };
}

async function loadProduct(idOrHandle: string) {
  const p = await prisma.product.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }], deletedAt: null }, include: productInclude });
  if (!p) throw ApiError.notFound("Product");
  return p;
}

async function view(cart: CartRow | null, o: CartOwner) {
  const shipping = await settingsService.get("shipping");
  return toCartView(cart, { freeShippingThreshold: shipping.freeShippingThreshold, guestToken: o.customerId ? undefined : (cart?.guestToken ?? undefined) });
}

async function touch(cartId: string) {
  // any change re-opens an abandoned bag (abandonedAt is kept so the order counts as recovered)
  await prisma.cart.update({ where: { id: cartId }, data: { lastActivityAt: new Date(), reminderStage: 0, status: "active" } });
}

async function ownedItem(o: CartOwner, itemId: string) {
  const cart = await find(o);
  const item = cart?.items.find((i) => i.id === itemId);
  if (!cart || !item) throw ApiError.notFound("Cart item");
  return { cart, item };
}

export const cartsService = {
  find,

  async get(o: CartOwner) {
    return view(await find(o), o);
  },

  async summary(o: CartOwner) {
    const cart = await find(o);
    const items = cart?.items ?? [];
    return { count: items.reduce((n, i) => n + i.qty, 0), lines: items.length };
  },

  async add(o: CartOwner, input: { productId: string; size?: string | null; color?: string | null; qty: number }, channel?: "web" | "mobile" | "pwa") {
    const p = await loadProduct(input.productId);
    const cart = await findOrCreate(o, channel);
    const owner = o.customerId ? o : { guestToken: cart.guestToken! };
    const coloured = p.variants.some((v) => v.color);
    const size = input.size ?? null;
    // same default as the product page: no colour picked → the first (default) colour
    const color = coloured ? (input.color ?? p.colors[0]?.name ?? null) : null;
    const existing = cart.items.find((i) => i.productId === p.id && i.size === size && i.color === color);
    const qty = Math.min(MAX_LINE_QTY, (existing?.qty ?? 0) + input.qty);
    const { variant, unitPrice } = assertSellable(p, size, color, qty);
    if (existing) await prisma.cartItem.update({ where: { id: existing.id }, data: { qty, unitPrice, variantId: variant.id } });
    else await prisma.cartItem.create({ data: { cartId: cart.id, productId: p.id, variantId: variant.id, size, color, qty, unitPrice } });
    await touch(cart.id);
    return view(await find(owner), owner);
  },

  /** change qty and/or size of one line (cart size picker) */
  async update(o: CartOwner, itemId: string, patch: { qty?: number; size?: string | null; color?: string | null }) {
    const { cart, item } = await ownedItem(o, itemId);
    const p = await loadProduct(item.productId);
    const size = patch.size !== undefined ? patch.size : item.size;
    const color = patch.color !== undefined ? patch.color : item.color;
    const qty = Math.min(MAX_LINE_QTY, patch.qty ?? item.qty);
    const { variant, unitPrice } = assertSellable(p, size, color, qty);
    const clash = cart.items.find((i) => i.id !== item.id && i.productId === item.productId && i.size === size && i.color === color);
    await prisma.$transaction(async (tx) => {
      if (clash) {
        // changing the size onto a line that already exists → merge the two lines
        await tx.cartItem.update({ where: { id: clash.id }, data: { qty: Math.min(MAX_LINE_QTY, clash.qty + qty), unitPrice } });
        await tx.cartItem.delete({ where: { id: item.id } });
      } else {
        await tx.cartItem.update({ where: { id: item.id }, data: { qty, size, color, variantId: variant.id, unitPrice } });
      }
    });
    await touch(cart.id);
    return this.get(o);
  },

  async remove(o: CartOwner, itemId: string) {
    const { cart, item } = await ownedItem(o, itemId);
    await prisma.cartItem.delete({ where: { id: item.id } });
    await touch(cart.id);
    return this.get(o);
  },

  async clear(o: CartOwner) {
    const cart = await find(o);
    if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.get(o);
  },

  /** "Sold out items removed from your cart" */
  async removeUnavailable(o: CartOwner) {
    const cart = await find(o);
    if (!cart) return { removed: [], cart: await view(null, o) };
    const current = await view(cart, o);
    const bad = current.items.filter((i) => i.issue);
    if (bad.length) await prisma.cartItem.deleteMany({ where: { id: { in: bad.map((b) => b.id) } } });
    return { removed: bad.map((b) => ({ id: b.id, name: b.name, issue: b.issue })), cart: await this.get(o) };
  },

  /** After sign-in: move the guest bag into the account bag (quantities add up, capped). */
  async merge(customerId: string, guestToken: string) {
    const guest = await find({ guestToken });
    if (!guest || !guest.items.length) return this.get({ customerId });
    const mine = await findOrCreate({ customerId }, guest.channel as "web");
    await prisma.$transaction(async (tx) => {
      for (const g of guest.items) {
        const same = mine.items.find((m) => m.productId === g.productId && m.size === g.size && m.color === g.color);
        if (same) await tx.cartItem.update({ where: { id: same.id }, data: { qty: Math.min(MAX_LINE_QTY, same.qty + g.qty) } });
        else await tx.cartItem.create({ data: { cartId: mine.id, productId: g.productId, variantId: g.variantId, size: g.size, color: g.color, qty: g.qty, unitPrice: g.unitPrice } });
      }
      await tx.cart.update({ where: { id: guest.id }, data: { status: "converted" } });
      await tx.cart.update({ where: { id: mine.id }, data: { lastActivityAt: new Date(), reminderStage: 0, status: "active", email: mine.email ?? guest.email } });
    });
    return this.get({ customerId });
  },

  /** reorder: add an old order's lines back to the bag, skipping what can't be bought */
  async addMany(o: CartOwner, lines: { productId: string; size: string | null; color: string | null; qty: number }[]) {
    const skipped: { productId: string; reason: string }[] = [];
    for (const l of lines) {
      try {
        await this.add(o, l);
      } catch (e) {
        skipped.push({ productId: l.productId, reason: e instanceof ApiError ? e.message : "Unavailable" });
      }
    }
    return { cart: await this.get(o), skipped };
  },

  /** order placed from this bag; a bag that had been abandoned counts as recovered */
  async markConverted(db: Db, cartId: string) {
    const c = await db.cart.findUniqueOrThrow({ where: { id: cartId }, select: { abandonedAt: true } });
    await db.cart.update({ where: { id: cartId }, data: c.abandonedAt ? { status: "recovered", recoveredAt: new Date() } : { status: "converted" } });
  },
};
