import type { Prisma } from "@/generated/prisma/client";
import { productInclude } from "@/modules/catalog/products/product.mapper";

export const cartInclude = {
  items: { orderBy: { createdAt: "asc" }, include: { product: { include: productInclude } } },
} satisfies Prisma.CartInclude;

export type CartRow = Prisma.CartGetPayload<{ include: typeof cartInclude }>;
type ItemRow = CartRow["items"][number];

export type CartIssue = "unavailable" | "sold_out" | "low_stock" | null;

function lineState(i: ItemRow) {
  const p = i.product;
  const v = p.variants.find((x) => x.id === i.variantId) ?? p.variants.find((x) => x.size === i.size && (!x.color || x.color === i.color));
  const price = v?.price ?? p.price;
  const free = v ? v.stock.reduce((n, s) => n + Math.max(0, s.onHand - s.reserved), 0) : 0;
  let issue: CartIssue = null;
  if (p.status !== "active" || p.deletedAt || !v || p.priceOnRequest) issue = "unavailable";
  else if (p.availability !== "pre_order" && free === 0) issue = "sold_out";
  else if (p.availability !== "pre_order" && free < i.qty) issue = "low_stock";
  return { price, free, issue };
}

/** The bag as both apps render it (`CartItem` in asl-web / asl-mobile + server checks). */
export function toCartView(cart: CartRow | null, o: { freeShippingThreshold: number; guestToken?: string }) {
  const items = (cart?.items ?? []).map((i) => {
    const s = lineState(i);
    const p = i.product;
    const sizeLabel = p.sizeLabels.find((l) => l.size === i.size)?.label ?? i.size;
    return {
      id: i.id,
      productId: p.handle,
      name: p.name,
      brand: p.brand.name,
      /** "White · UK 9" — the line under the name */
      variant: [i.color, sizeLabel].filter(Boolean).join(" · "),
      size: i.size,
      color: i.color,
      qty: i.qty,
      price: s.price,
      /** price when it was added; shown as "price changed" when different */
      priceWhenAdded: i.unitPrice,
      priceChanged: i.unitPrice !== s.price,
      lineTotal: s.price * i.qty,
      image: p.images.find((img) => img.color && img.color === i.color)?.url ?? p.images[0]?.url ?? null,
      available: s.free,
      issue: s.issue,
    };
  });
  const sellable = items.filter((i) => i.issue !== "unavailable" && i.issue !== "sold_out");
  const subtotal = sellable.reduce((n, i) => n + i.lineTotal, 0);
  return {
    id: cart?.id ?? null,
    guestToken: o.guestToken ?? null,
    items,
    count: items.reduce((n, i) => n + i.qty, 0),
    subtotal,
    hasIssues: items.some((i) => i.issue),
    freeShipping: {
      threshold: o.freeShippingThreshold,
      remaining: Math.max(0, o.freeShippingThreshold - subtotal),
      qualified: subtotal >= o.freeShippingThreshold,
    },
  };
}
