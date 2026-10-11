/**
 * Coupon rules engine + admin coupon management.
 * Check order: status/dates → channel → eligibility → limits → min subtotal → applies-to → discount (capped).
 * The checkout UI's hard-coded codes (ASL20OFF, WELCOME10 …) now live in this table.
 */
import type { Coupon, CustomerCoupon, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { smartWhere, type SmartRule } from "@/modules/catalog/products/products.query";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import type { CouponBody, CouponListQuery, CouponPatch } from "./coupons.schemas";

export type PricedLine = {
  productId: string;
  categoryHandle: string;
  subcategoryHandle: string | null;
  brandHandle: string;
  unitPrice: number;
  qty: number;
};
export type CouponChannel = "web" | "mobile" | "concierge";
export type CouponContext = { customerId?: string | null; channel: CouponChannel; lines: PricedLine[]; subtotal: number; shipping: number };
export type AppliedCoupon = {
  code: string;
  title: string;
  source: "coupon" | "personal";
  couponId?: string;
  customerCouponId?: string;
  discount: number;
  freeShipping: boolean;
  stackable: boolean;
};

const VIP_TIERS = new Set(["Gold", "Signature"]);
const invalid = (msg = "This coupon code is not valid.") => ApiError.badRequest("COUPON_INVALID", msg);

/** what the admin table shows: dates win over the stored status */
export function effectiveStatus(c: Pick<Coupon, "status" | "startsAt" | "endsAt">, now = new Date()) {
  if (c.status === "draft" || c.status === "paused") return c.status;
  if (c.endsAt && c.endsAt < now) return "expired";
  if (c.startsAt && c.startsAt > now) return "scheduled";
  return c.status === "expired" ? "expired" : "active";
}

async function eligibleLines(c: Coupon, lines: PricedLine[]) {
  if (c.appliesTo === "all") return lines;
  const refs = new Set(((c.appliesToRefs as string[]) ?? []).map((r) => r.toLowerCase()));
  switch (c.appliesTo) {
    case "categories":
      return lines.filter((l) => refs.has(l.categoryHandle) || (l.subcategoryHandle && refs.has(l.subcategoryHandle)));
    case "brands":
      return lines.filter((l) => refs.has(l.brandHandle));
    case "products": {
      const products = await prisma.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } }, select: { id: true, handle: true } });
      const ok = new Set(products.filter((p) => refs.has(p.id.toLowerCase()) || refs.has(p.handle.toLowerCase())).map((p) => p.id));
      return lines.filter((l) => ok.has(l.productId));
    }
    case "collections": {
      const collections = await prisma.collection.findMany({ where: { OR: [{ handle: { in: [...refs] } }, { id: { in: [...refs] } }] } });
      const ok = new Set<string>();
      const ids = lines.map((l) => l.productId);
      for (const col of collections) {
        const rows =
          col.type === "smart"
            ? await prisma.product.findMany({ where: { AND: [smartWhere((col.rules as SmartRule[]) ?? []), { id: { in: ids } }] }, select: { id: true } })
            : (await prisma.collectionProduct.findMany({ where: { collectionId: col.id, productId: { in: ids } }, select: { productId: true } })).map((r) => ({ id: r.productId }));
        rows.forEach((r) => ok.add(r.id));
      }
      return lines.filter((l) => ok.has(l.productId));
    }
  }
  return lines;
}

function bogoDiscount(lines: PricedLine[], pct: number) {
  const units = lines.flatMap((l) => Array.from({ length: l.qty }, () => l.unitPrice)).sort((a, b) => b - a);
  // every second unit (the cheaper of each pair) gets `pct`% off
  return units.reduce((n, price, i) => (i % 2 === 1 ? n + Math.round((price * pct) / 100) : n), 0);
}

async function evaluateCoupon(c: Coupon, ctx: CouponContext): Promise<AppliedCoupon> {
  const now = new Date();
  const status = effectiveStatus(c, now);
  if (status === "expired") throw ApiError.badRequest("COUPON_EXPIRED", "This coupon has expired.");
  if (status !== "active") throw invalid("This coupon is not active yet.");
  if (!(c.channels as string[]).includes(ctx.channel)) throw invalid(ctx.channel === "concierge" ? "This coupon can't be used on concierge requests." : "This coupon can't be used here.");

  if (c.eligibility !== "all" || c.perCustomerLimit || c.oncePerCustomer) {
    if (!ctx.customerId) throw ApiError.unauthenticated("Sign in to use this coupon.");
  }
  if (c.eligibility !== "all") {
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: ctx.customerId! }, select: { status: true, tier: true } });
    if (c.eligibility === "new") {
      const paid = await prisma.order.count({ where: { customerId: ctx.customerId!, paymentStatus: { in: ["paid", "partially_refunded", "refunded"] } } });
      if (paid) throw invalid("This coupon is for your first order only.");
    } else if (c.eligibility === "vip") {
      if (customer.status !== "vip" && !VIP_TIERS.has(customer.tier)) throw invalid("This coupon is for Gold and Signature members.");
    } else {
      // customer segments arrive with the marketing module; until then segment coupons can't be redeemed
      throw invalid("This coupon is not available for your account.");
    }
  }
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) throw ApiError.badRequest("COUPON_LIMIT_REACHED", "This coupon has reached its usage limit.");
  if (ctx.customerId && (c.perCustomerLimit || c.oncePerCustomer)) {
    const mine = await prisma.couponRedemption.count({ where: { couponId: c.id, customerId: ctx.customerId } });
    const limit = c.oncePerCustomer ? 1 : c.perCustomerLimit!;
    if (mine >= limit) throw ApiError.badRequest("COUPON_LIMIT_REACHED", "You've already used this coupon.");
  }
  if (c.minSubtotal && ctx.subtotal < c.minSubtotal)
    throw ApiError.badRequest("COUPON_MIN_SUBTOTAL", `Spend ₦${(c.minSubtotal / 100).toLocaleString("en-NG")} or more to use this coupon.`, { minSubtotal: c.minSubtotal });

  const lines = await eligibleLines(c, ctx.lines);
  if (!lines.length) throw invalid("This coupon doesn't apply to the items in your bag.");
  const base = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  let discount = 0;
  if (c.type === "percent") discount = Math.round((base * c.value) / 100);
  else if (c.type === "fixed") discount = Math.min(c.value, base);
  else if (c.type === "bogo") {
    if (lines.reduce((n, l) => n + l.qty, 0) < 2) throw invalid("Add two eligible items to use this offer.");
    discount = bogoDiscount(lines, c.value);
  }
  if (c.maxDiscount != null) discount = Math.min(discount, c.maxDiscount);
  return { code: c.code, title: c.title, source: "coupon", couponId: c.id, discount, freeShipping: c.type === "free_shipping", stackable: c.stackable };
}

function evaluatePersonal(cc: CustomerCoupon, ctx: CouponContext): AppliedCoupon {
  if (!ctx.customerId || ctx.customerId !== cc.customerId) throw invalid();
  if (cc.usedAt) throw ApiError.badRequest("COUPON_LIMIT_REACHED", "You've already used this coupon.");
  if (cc.expiresAt && cc.expiresAt < new Date()) throw ApiError.badRequest("COUPON_EXPIRED", "This coupon has expired.");
  const discount =
    cc.type === "percent" ? Math.round((ctx.subtotal * cc.value) / 100) : cc.type === "fixed" ? Math.min(cc.value, ctx.subtotal) : 0;
  return { code: cc.code, title: cc.label, source: "personal", customerCouponId: cc.id, discount, freeShipping: cc.type === "free_shipping", stackable: false };
}

const benefit = (a: AppliedCoupon, shipping: number) => a.discount + (a.freeShipping ? shipping : 0);

const toAdmin = (c: Coupon) => ({
  ...c,
  appliesToRefs: (c.appliesToRefs as string[]) ?? [],
  channels: c.channels as string[],
  revenue: Number(c.revenue),
  used: c.usedCount,
  status: effectiveStatus(c),
});

export const couponsService = {
  /** Validate one code against the bag. Throws COUPON_* with a message the apps show as-is. */
  async evaluate(rawCode: string, ctx: CouponContext): Promise<AppliedCoupon> {
    const code = rawCode.trim().toUpperCase();
    if (!code) throw invalid("Enter a coupon code.");
    const c = await prisma.coupon.findUnique({ where: { code } });
    if (c) return evaluateCoupon(c, ctx);
    const cc = await prisma.customerCoupon.findUnique({ where: { code } });
    if (cc) return evaluatePersonal(cc, ctx);
    throw invalid();
  },

  /**
   * Everything that applies to this bag: the code the customer typed (if any) plus
   * auto-apply coupons (e.g. FREESHIP). Non-stackable coupons never combine.
   */
  async resolve(ctx: CouponContext, manualCode?: string | null) {
    const applied: AppliedCoupon[] = [];
    let error: ApiError | null = null;
    if (manualCode) {
      try {
        applied.push(await this.evaluate(manualCode, ctx));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        error = e;
      }
    }
    const autos = await prisma.coupon.findMany({ where: { autoApply: true, status: { in: ["active", "scheduled"] } } });
    const candidates: AppliedCoupon[] = [];
    for (const a of autos) {
      if (applied.some((x) => x.code === a.code)) continue;
      try {
        candidates.push(await evaluateCoupon(a, ctx));
      } catch {
        /* auto coupons that don't apply are skipped silently */
      }
    }
    candidates.sort((x, y) => benefit(y, ctx.shipping) - benefit(x, ctx.shipping));
    for (const cand of candidates) {
      // an auto coupon that saves nothing (e.g. FREESHIP when delivery is already free) isn't applied or counted
      if (benefit(cand, ctx.shipping) <= 0) continue;
      if (!applied.length) applied.push(cand);
      else if (applied.every((x) => x.stackable) && cand.stackable) applied.push(cand);
    }
    const discount = Math.min(ctx.subtotal, applied.reduce((n, a) => n + a.discount, 0));
    return { applied, discount, freeShipping: applied.some((a) => a.freeShipping), error };
  },

  /** at place-order (inside the order transaction) */
  async redeem(tx: Tx, applied: AppliedCoupon[], orderId: string, customerId: string | null) {
    for (const a of applied) {
      if (a.couponId) {
        // guarded increment: two customers can't both take the last use
        const n = await tx.$executeRaw`UPDATE \`Coupon\` SET usedCount = usedCount + 1 WHERE id = ${a.couponId} AND (usageLimit IS NULL OR usedCount < usageLimit)`;
        if (!n) throw ApiError.badRequest("COUPON_LIMIT_REACHED", "This coupon has just reached its usage limit.");
      }
      if (a.customerCouponId) {
        const r = await tx.customerCoupon.updateMany({ where: { id: a.customerCouponId, usedAt: null }, data: { usedAt: new Date(), orderId } });
        if (!r.count) throw ApiError.badRequest("COUPON_LIMIT_REACHED", "You've already used this coupon.");
      }
      await tx.couponRedemption.create({
        data: { couponId: a.couponId ?? null, customerCouponId: a.customerCouponId ?? null, code: a.code, customerId, orderId, discount: a.discount },
      });
    }
  },

  /** order cancelled before payment → give the uses back */
  async release(tx: Tx, orderId: string) {
    const rows = await tx.couponRedemption.findMany({ where: { orderId } });
    for (const r of rows) {
      if (r.couponId) await tx.$executeRaw`UPDATE \`Coupon\` SET usedCount = GREATEST(usedCount - 1, 0) WHERE id = ${r.couponId}`;
      if (r.customerCouponId) await tx.customerCoupon.update({ where: { id: r.customerCouponId }, data: { usedAt: null, orderId: null } });
    }
    await tx.couponRedemption.deleteMany({ where: { orderId } });
  },

  /** paid → count the revenue on the coupon (admin "Revenue" column) */
  async recordRevenue(tx: Tx, orderId: string, total: number) {
    const rows = await tx.couponRedemption.findMany({ where: { orderId, couponId: { not: null } }, select: { couponId: true } });
    for (const r of rows) await tx.coupon.update({ where: { id: r.couponId! }, data: { revenue: { increment: total } } });
  },

  /** "Your coupons" chips on the payment step */
  async mine(customerId: string) {
    const rows = await prisma.customerCoupon.findMany({
      where: { customerId, usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((c) => ({ code: c.code, label: c.label, type: c.type, value: c.value, pct: c.type === "percent" ? c.value : null, source: c.source, expiresAt: c.expiresAt }));
  },

  // ── admin /coupons ──
  async list(q: CouponListQuery) {
    const now = new Date();
    const statusWhere: Record<string, Prisma.CouponWhereInput> = {
      all: {},
      active: { status: { in: ["active", "scheduled"] }, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }] },
      scheduled: { status: { in: ["active", "scheduled"] }, startsAt: { gt: now } },
      expired: { OR: [{ status: "expired" }, { status: { in: ["active", "scheduled"] }, endsAt: { lt: now } }] },
      paused: { status: "paused" },
      draft: { status: "draft" },
    };
    const where: Prisma.CouponWhereInput = {
      AND: [statusWhere[q.status], q.type ? { type: q.type } : {}, q.q ? { OR: [{ code: { contains: q.q } }, { title: { contains: q.q } }] } : {}],
    };
    const [rows, total, all] = await Promise.all([
      prisma.coupon.findMany({ where, ...paging(q), orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }] }),
      prisma.coupon.count({ where }),
      prisma.coupon.findMany({ select: { status: true, startsAt: true, endsAt: true, usedCount: true, revenue: true } }),
    ]);
    const tabs = { all: all.length, active: 0, scheduled: 0, expired: 0, paused: 0, draft: 0 } as Record<string, number>;
    for (const c of all) tabs[effectiveStatus(c, now)]++;
    const kpis = {
      redemptions: all.reduce((n, c) => n + c.usedCount, 0),
      revenue: all.reduce((n, c) => n + Number(c.revenue), 0),
      active: tabs.active,
    };
    return withMeta(rows.map(toAdmin), { ...pageMeta(q, total), tabs, kpis });
  },

  async get(id: string) {
    const c = await prisma.coupon.findUnique({ where: { id } });
    if (!c) throw ApiError.notFound("Coupon");
    return toAdmin(c);
  },

  async create(b: CouponBody) {
    if (await prisma.coupon.findUnique({ where: { code: b.code } })) throw ApiError.conflict("CONFLICT", `Code ${b.code} already exists.`);
    return toAdmin(await prisma.coupon.create({ data: { ...b, appliesToRefs: b.appliesToRefs, channels: b.channels } }));
  },

  async update(id: string, patch: CouponPatch) {
    const before = await this.get(id);
    if (patch.code && patch.code !== before.code && (await prisma.coupon.findUnique({ where: { code: patch.code } })))
      throw ApiError.conflict("CONFLICT", `Code ${patch.code} already exists.`);
    const after = toAdmin(await prisma.coupon.update({ where: { id }, data: patch }));
    return { before, after };
  },

  async duplicate(id: string) {
    const c = await prisma.coupon.findUniqueOrThrow({ where: { id } });
    let code = `${c.code}-COPY`;
    for (let i = 2; await prisma.coupon.findUnique({ where: { code } }); i++) code = `${c.code}-COPY${i}`;
    const { id: _id, createdAt: _c, updatedAt: _u, usedCount: _n, revenue: _r, pinned: _p, ...rest } = c;
    return toAdmin(
      await prisma.coupon.create({
        data: { ...rest, code, title: `${c.title} (copy)`, status: "draft", appliesToRefs: (c.appliesToRefs as string[]) ?? [], channels: c.channels as string[] },
      }),
    );
  },

  async setStatus(id: string, status: Coupon["status"]) {
    return toAdmin(await prisma.coupon.update({ where: { id }, data: { status } }));
  },

  async togglePin(id: string) {
    const c = await prisma.coupon.findUniqueOrThrow({ where: { id } });
    return toAdmin(await prisma.coupon.update({ where: { id }, data: { pinned: !c.pinned } }));
  },

  async remove(id: string) {
    await prisma.coupon.delete({ where: { id } });
    return { deleted: true };
  },

  async redemptions(id: string, q: { page: number; pageSize: number }) {
    const where = { couponId: id };
    const [rows, total] = await Promise.all([
      prisma.couponRedemption.findMany({
        where, ...paging(q), orderBy: { createdAt: "desc" },
        include: { order: { select: { number: true, total: true, status: true } }, customer: { select: { firstName: true, lastName: true, email: true } } },
      }),
      prisma.couponRedemption.count({ where }),
    ]);
    return withMeta(
      rows.map((r) => ({ id: r.id, code: r.code, discount: r.discount, createdAt: r.createdAt, order: r.order, customer: r.customer ? { name: fullName(r.customer), email: r.customer.email } : null })),
      pageMeta(q, total),
    );
  },
};
