/**
 * Till pricing (VAT-inclusive). Mirrors asl-originals-pos/src/lib/pricing.ts
 * so web checkout and POS stay consistent on money maths.
 */
import type { Coupon } from "@/generated/prisma/client";

export type PosDisc = { type: "percent" | "amount"; value: number; max?: number };

export type PosLineIn = {
  qty: number;
  unitPrice: number;
  discount?: PosDisc;
  category?: string;
  brand?: string;
  noPromo?: boolean;
};

export type PosPromo = {
  id: string;
  label: string;
  kind: "bxgy" | "percent" | "spend" | "birthday";
  buy?: number | null;
  get?: number | null;
  value: number;
  minSpend?: number | null;
  scope: { type: "all" | "category" | "brand"; value?: string };
};

export function applyPromos(
  lines: PosLineIn[],
  bases: number[],
  promos: PosPromo[],
  opts: { birthdayMonth?: boolean } = {},
) {
  const off = lines.map(() => 0);
  const applied: { id: string; label: string; amount: number }[] = [];
  const inScope = (p: PosPromo, l: PosLineIn) =>
    p.scope.type === "all" || (p.scope.type === "category" ? l.category === p.scope.value : l.brand === p.scope.value);

  for (const p of promos) {
    const idx = lines.map((_, i) => i).filter((i) => !lines[i].noPromo && inScope(p, lines[i]) && bases[i] - off[i] > 0);
    if (!idx.length) continue;
    const take = lines.map(() => 0);
    if (p.kind === "bxgy" && p.buy && p.get) {
      const units = idx
        .flatMap((i) => Array.from({ length: lines[i].qty }, () => ({ i, price: (bases[i] - off[i]) / lines[i].qty })))
        .sort((a, b) => b.price - a.price);
      const free = Math.floor(units.length / (p.buy + p.get)) * p.get;
      for (const u of free ? units.slice(-free) : []) take[u.i] += Math.round(u.price);
    } else if (p.kind === "percent" || (p.kind === "birthday" && opts.birthdayMonth)) {
      for (const i of idx) take[i] = Math.round(((bases[i] - off[i]) * p.value) / 100);
    } else if (p.kind === "spend") {
      const scoped = idx.reduce((a, i) => a + bases[i] - off[i], 0);
      if (scoped >= (p.minSpend ?? 0)) {
        const shares = allocate(Math.min(p.value, scoped), idx.map((i) => bases[i] - off[i]));
        idx.forEach((i, k) => (take[i] = shares[k]));
      }
    }
    const amount = take.reduce((a, b) => a + b, 0);
    if (amount <= 0) continue;
    take.forEach((t, i) => (off[i] += Math.min(t, bases[i] - off[i])));
    applied.push({ id: p.id, label: p.label, amount });
  }
  return { off, applied };
}

export function discountOf(base: number, d?: PosDisc) {
  if (!d || base <= 0) return 0;
  const raw = Math.min(d.type === "percent" ? (base * d.value) / 100 : d.value, d.max ?? Infinity);
  return Math.min(base, Math.max(0, Math.round(raw)));
}

export function allocate(total: number, weights: number[]) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (const [, i] of exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])) {
    if (left-- <= 0) break;
    shares[i] += 1;
  }
  return shares;
}

export function vatIncluded(total: number, ratePct: number) {
  return Math.round((total * ratePct) / (100 + ratePct));
}

/** Refund for `qty` more units of a line. Last unit takes whatever is left. */
export function refundFor(net: number, bought: number, alreadyQty: number, alreadyAmount: number, qty: number) {
  if (qty <= 0 || alreadyQty + qty > bought) return 0;
  if (alreadyQty + qty === bought) return net - alreadyAmount;
  return Math.round((net * qty) / bought);
}

export function couponProblem(coupon: Coupon | null | undefined, afterLines: number, channels: unknown): string | null {
  if (!coupon) return "That code doesn't exist";
  if (coupon.status !== "active") return "That code has ended";
  const ch = Array.isArray(channels) ? (channels as string[]) : Array.isArray(coupon.channels) ? (coupon.channels as string[]) : [];
  if (!ch.includes("store")) return "That code is for online orders only";
  if (coupon.startsAt && coupon.startsAt > new Date()) return "That code is not active yet";
  if (coupon.endsAt && coupon.endsAt < new Date()) return "That code has ended";
  if (coupon.minSubtotal != null && afterLines < coupon.minSubtotal) {
    return `Needs a spend of ₦${Math.round(coupon.minSubtotal / 100).toLocaleString("en-NG")} or more`;
  }
  return null;
}

export type PosQuote = {
  lines: { gross: number; lineDiscount: number; net: number }[];
  subtotal: number;
  lineDiscounts: number;
  coupon: number;
  couponError: string | null;
  manual: number;
  points: number;
  pointsUsed: number;
  discountTotal: number;
  total: number;
  vat: number;
  due: number;
};

export function quotePos(args: {
  lines: PosLineIn[];
  coupon?: Coupon | null;
  manual?: PosDisc;
  pointsToUse: number;
  pointValueKobo: number;
  customerPoints: number;
  vatRatePct: number;
  redeemLoyalty: boolean;
  promos?: PosPromo[];
  birthdayMonth?: boolean;
  extras?: number;
}): PosQuote & { promos: { id: string; label: string; amount: number }[]; promoTotal: number; extras: number } {
  const manualLine = args.lines.map((l) => discountOf(l.qty * l.unitPrice, l.discount));
  const bases = args.lines.map((l, i) => l.qty * l.unitPrice - manualLine[i]);
  const promo = applyPromos(args.lines, bases, args.promos ?? [], { birthdayMonth: args.birthdayMonth });
  const priced = args.lines.map((l, i) => {
    const gross = l.qty * l.unitPrice;
    const lineDiscount = manualLine[i] + promo.off[i];
    return { gross, lineDiscount, promo: promo.off[i], after: gross - lineDiscount };
  });
  const afterLines = priced.reduce((a, l) => a + l.after, 0);
  const extras = args.extras ?? 0;

  let coupon = 0;
  let couponError: string | null = null;
  if (args.coupon) {
    couponError = couponProblem(args.coupon, afterLines, args.coupon.channels);
    if (!couponError) {
      coupon = discountOf(afterLines, {
        type: args.coupon.type === "fixed" ? "amount" : "percent",
        value: args.coupon.value,
        max: args.coupon.maxDiscount ?? undefined,
      });
    }
  }

  const manual = discountOf(afterLines - coupon, args.manual);
  const beforePoints = afterLines - coupon - manual;
  const maxPoints = args.redeemLoyalty
    ? Math.min(args.customerPoints, args.pointValueKobo > 0 ? Math.floor(beforePoints / args.pointValueKobo) : 0)
    : 0;
  const pointsUsed = Math.max(0, Math.min(args.pointsToUse, maxPoints));
  const points = pointsUsed * args.pointValueKobo;
  const goods = beforePoints - points;
  const total = goods + extras;
  const shares = allocate(coupon + manual + points, priced.map((l) => l.after));

  return {
    lines: priced.map((l, i) => ({
      gross: l.gross,
      lineDiscount: l.lineDiscount + shares[i],
      net: l.after - shares[i],
    })),
    subtotal: priced.reduce((a, l) => a + l.gross, 0),
    lineDiscounts: priced.reduce((a, l) => a + l.lineDiscount - l.promo, 0),
    promos: promo.applied,
    promoTotal: promo.applied.reduce((a, p) => a + p.amount, 0),
    extras,
    coupon,
    couponError,
    manual,
    points,
    pointsUsed,
    discountTotal: priced.reduce((a, l) => a + l.lineDiscount, 0) + coupon + manual + points,
    total,
    vat: vatIncluded(Math.max(0, goods), args.vatRatePct),
    due: total,
  };
}
