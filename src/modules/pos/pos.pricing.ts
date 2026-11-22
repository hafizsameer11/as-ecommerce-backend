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
};

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
}): PosQuote {
  const priced = args.lines.map((l) => {
    const gross = l.qty * l.unitPrice;
    const lineDiscount = discountOf(gross, l.discount);
    return { gross, lineDiscount, after: gross - lineDiscount };
  });
  const afterLines = priced.reduce((a, l) => a + l.after, 0);

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
  const total = beforePoints - points;
  const shares = allocate(coupon + manual + points, priced.map((l) => l.after));

  return {
    lines: priced.map((l, i) => ({
      gross: l.gross,
      lineDiscount: l.lineDiscount + shares[i],
      net: l.after - shares[i],
    })),
    subtotal: priced.reduce((a, l) => a + l.gross, 0),
    lineDiscounts: priced.reduce((a, l) => a + l.lineDiscount, 0),
    coupon,
    couponError,
    manual,
    points,
    pointsUsed,
    discountTotal: priced.reduce((a, l) => a + l.lineDiscount, 0) + coupon + manual + points,
    total,
    vat: vatIncluded(total, args.vatRatePct),
    due: total,
  };
}
