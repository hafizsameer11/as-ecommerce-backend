import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { hashPassword } from "@/core/auth/password";
import { POS_DISCOUNT_LIMITS, ROLE_PERMISSIONS } from "@/core/auth/permissions";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { pickupsService } from "@/modules/fulfilment/pickups/pickups.service";
import { warehousesService } from "@/modules/inventory/inventory.service";
import { posPromotionsService } from "./pos.promotions.service";
import type { PosPromo } from "./pos.pricing";
import type { AdminCouponChannelsPatch, AdminLocationPatch, AdminStaffBody } from "./pos.admin.schemas";

const STORE_ROLES = ["store_cashier", "store_supervisor", "store_manager"] as const;

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const posAdminService = {
  async overview() {
    const today = startOfDay();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const tomorrow = new Date(today.getTime() + 86_400_000);

    const [ordersToday, ordersYesterday, returnsToday, registers, openSessions, openLayaways, activeGiftBalance, pendingTransfers, readyAlterations] =
      await Promise.all([
        prisma.order.findMany({
          where: { channel: "store", placedAt: { gte: today, lt: tomorrow }, status: { not: "cancelled" } },
          select: { id: true, total: true, registerId: true, cashierId: true, pickupLocationId: true, placedAt: true },
        }),
        prisma.order.findMany({
          where: { channel: "store", placedAt: { gte: yesterday, lt: today }, status: { not: "cancelled" } },
          select: { total: true },
        }),
        prisma.returnRequest.findMany({
          where: { createdAt: { gte: today, lt: tomorrow }, order: { channel: "store" } },
          select: { refundAmount: true },
        }),
        prisma.posRegister.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
        prisma.posRegisterSession.findMany({
          where: { closedAt: null },
          include: { register: true },
        }),
        prisma.posLayaway.count({ where: { status: "open", until: { lte: new Date(Date.now() + 3 * 86_400_000) } } }),
        prisma.giftCard.aggregate({ where: { status: "active" }, _sum: { balance: true } }),
        prisma.posStockTransfer.count({ where: { status: { in: ["requested", "approved", "in-transit"] } } }),
        prisma.posAlteration.count({ where: { status: "ready" } }),
      ]);

    const sum = (xs: { total: number }[]) => xs.reduce((a, o) => a + o.total, 0);
    const sales = sum(ordersToday);
    const salesY = sum(ordersYesterday);
    const hours = Array.from({ length: 12 }, (_, i) => i + 9);
    const byHour = hours.map((h) => ({
      hour: h,
      total: ordersToday.filter((o) => o.placedAt.getHours() === h).reduce((a, o) => a + o.total, 0),
      count: ordersToday.filter((o) => o.placedAt.getHours() === h).length,
    }));

    const locationIds = [...new Set(registers.map((r) => r.locationId))];
    const locations = await prisma.pickupLocation.findMany({ where: { id: { in: locationIds } } });
    const locName = new Map(locations.map((l) => [l.id, l.name]));

    const byStore = locationIds.map((id) => {
      const mine = ordersToday.filter((o) => o.pickupLocationId === id);
      return { locationId: id, name: locName.get(id) ?? id, total: sum(mine), count: mine.length };
    });

    const staffIds = [...new Set(ordersToday.map((o) => o.cashierId).filter(Boolean) as string[])];
    const staff = staffIds.length
      ? await prisma.adminUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true, role: true } })
      : [];
    const byStaff = staff
      .map((s) => {
        const mine = ordersToday.filter((o) => o.cashierId === s.id);
        return { staffId: s.id, name: s.name, role: s.role, total: sum(mine), count: mine.length };
      })
      .sort((a, b) => b.total - a.total);

    const openByRegister = new Map(openSessions.map((s) => [s.registerId, s]));
    const registerRows = registers.map((r) => {
      const open = openByRegister.get(r.id);
      const todaySales = ordersToday.filter((o) => o.registerId === r.id).reduce((a, o) => a + o.total, 0);
      return {
        ...r,
        locationName: locName.get(r.locationId) ?? null,
        session: open
          ? { id: open.id, openedAt: open.openedAt, openedById: open.openedById, float: open.float }
          : null,
        salesToday: todaySales,
      };
    });

    return {
      today: {
        sales,
        salesYesterday: salesY,
        count: ordersToday.length,
        countYesterday: ordersYesterday.length,
        avg: ordersToday.length ? Math.round(sales / ordersToday.length) : 0,
        returns: returnsToday.reduce((a, r) => a + r.refundAmount, 0),
        returnCount: returnsToday.length,
      },
      byHour,
      byStore,
      byStaff,
      registers: registerRows,
      attention: {
        layawaysDueSoon: openLayaways,
        pendingTransfers,
        alterationsReady: readyAlterations,
        giftCardLiability: activeGiftBalance._sum.balance ?? 0,
      },
    };
  },

  async transactions(q: {
    page: number;
    pageSize: number;
    q?: string;
    locationId?: string;
    registerId?: string;
    from?: string;
    to?: string;
    fulfilment?: string;
  }) {
    const where: Prisma.OrderWhereInput = {
      channel: "store",
      ...(q.locationId ? { pickupLocationId: q.locationId } : {}),
      ...(q.registerId ? { registerId: q.registerId } : {}),
      ...(q.from || q.to
        ? {
            placedAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
      ...(q.fulfilment === "ship"
        ? { deliveryMethod: "ship" }
        : q.fulfilment === "layaway"
          ? { /* filtered via join below */ }
          : q.fulfilment === "instore"
            ? { deliveryMethod: "instore" }
            : {}),
      ...(q.q
        ? {
            OR: [
              { number: { contains: q.q } },
              { guestEmail: { contains: q.q } },
              { customer: { OR: [{ email: { contains: q.q } }, { firstName: { contains: q.q } }, { lastName: { contains: q.q } }] } },
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
        payments: o.payments.map((p) => ({ method: p.method, amount: p.amount })),
        items: o.items,
        itemCount: o.items.reduce((a, i) => a + i.qty, 0),
        layaway: layByOrder.get(o.id) ?? null,
      })),
      pageMeta(q, total),
    );
  },

  async reports(q: { from?: string; to?: string; locationId?: string }) {
    const from = q.from ? new Date(q.from) : startOfDay(new Date(Date.now() - 6 * 86_400_000));
    const to = q.to ? new Date(q.to) : new Date();
    const orders = await prisma.order.findMany({
      where: {
        channel: "store",
        placedAt: { gte: from, lte: to },
        status: { not: "cancelled" },
        ...(q.locationId ? { pickupLocationId: q.locationId } : {}),
      },
      include: { payments: true, items: true },
    });
    const byMethod: Record<string, number> = {};
    for (const o of orders) for (const p of o.payments) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    const byDayMap = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const key = o.placedAt.toISOString().slice(0, 10);
      const cur = byDayMap.get(key) ?? { total: 0, count: 0 };
      cur.total += o.total;
      cur.count += 1;
      byDayMap.set(key, cur);
    }
    const commission = new Map<string, { qty: number; net: number }>();
    for (const o of orders) {
      for (const i of o.items) {
        if (!i.soldById) continue;
        const cur = commission.get(i.soldById) ?? { qty: 0, net: 0 };
        cur.qty += i.qty;
        cur.net += i.lineTotal;
        commission.set(i.soldById, cur);
      }
    }
    const staffIds = [...commission.keys()];
    const staff = staffIds.length
      ? await prisma.adminUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(staff.map((s) => [s.id, s.name]));

    type RowAgg = { label: string; sub?: string; imageUrl?: string; net: number; units: number; orderIds: Set<string> };
    const bump = (m: Map<string, RowAgg>, key: string, meta: { label: string; sub?: string; imageUrl?: string }, orderId: string, net: number, units: number) => {
      const cur = m.get(key) ?? { ...meta, net: 0, units: 0, orderIds: new Set<string>() };
      cur.net += net;
      cur.units += units;
      cur.orderIds.add(orderId);
      if (!cur.sub && meta.sub) cur.sub = meta.sub;
      if (!cur.imageUrl && meta.imageUrl) cur.imageUrl = meta.imageUrl;
      m.set(key, cur);
    };

    const productIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.productId).filter((id): id is string => !!id)))];
    const productRows = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, category: { select: { name: true } } } })
      : [];
    const categoryOf = new Map(productRows.map((p) => [p.id, p.category.name]));

    const byProduct = new Map<string, RowAgg>();
    const byCategory = new Map<string, RowAgg>();
    const byBrand = new Map<string, RowAgg>();
    const bySize = new Map<string, RowAgg>();
    const discountRows = new Map<string, { label: string; kind: string; amount: number; uses: number }>();

    const addDiscount = (key: string, label: string, kind: string, amount: number) => {
      if (amount <= 0) return;
      const cur = discountRows.get(key) ?? { label, kind, amount: 0, uses: 0 };
      discountRows.set(key, { label, kind, amount: cur.amount + amount, uses: cur.uses + 1 });
    };

    for (const o of orders) {
      if (o.couponCode && o.discount > 0) addDiscount(`coupon-${o.couponCode}`, o.couponCode, "Promo code", o.discount);
      let lineDiscSum = 0;
      for (const i of o.items) {
        const net = i.lineTotal;
        const units = i.qty;
        const pKey = i.productId ?? i.name;
        bump(byProduct, pKey, { label: i.name, sub: i.brand, imageUrl: i.imageUrl ?? undefined }, o.id, net, units);
        bump(byBrand, i.brand || "Unknown", { label: i.brand || "Unknown" }, o.id, net, units);
        const cat = (i.productId && categoryOf.get(i.productId)) || "Other";
        bump(byCategory, cat, { label: cat }, o.id, net, units);
        const size = i.size?.trim() || "One size";
        bump(bySize, size, { label: size }, o.id, net, units);
        lineDiscSum += i.lineDiscount;
      }
      if (lineDiscSum > 0) addDiscount("item", "Item discounts", "Staff discount", lineDiscSum);
      const orderDisc = Math.max(0, o.discount - lineDiscSum);
      if (orderDisc > 0) addDiscount("basket", "Basket / promotion", "Automatic promotion", orderDisc);
    }

    const toRank = (m: Map<string, RowAgg>) =>
      [...m.entries()]
        .map(([key, v]) => ({ key, label: v.label, sub: v.sub, imageUrl: v.imageUrl, net: v.net, units: v.units, orders: v.orderIds.size }))
        .sort((a, b) => b.net - a.net);

    const orderIds = orders.map((o) => o.id);
    const returnRows = orderIds.length
      ? await prisma.returnRequest.findMany({
          where: {
            orderId: { in: orderIds },
            refundAmount: { gt: 0 },
            refundedAt: { gte: from, lte: to },
          },
          include: { order: { select: { number: true } } },
          orderBy: { refundedAt: "desc" },
        })
      : [];

    return {
      from,
      to,
      salesTotal: orders.reduce((a, o) => a + o.total, 0),
      orderCount: orders.length,
      discountTotal: orders.reduce((a, o) => a + o.discount, 0),
      refundTotal: returnRows.reduce((a, r) => a + r.refundAmount, 0),
      byMethod,
      byDay: [...byDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
      salesCredit: [...commission.entries()].map(([staffId, v]) => ({
        staffId,
        name: nameOf.get(staffId) ?? staffId,
        ...v,
      })),
      byProduct: toRank(byProduct),
      byCategory: toRank(byCategory),
      byBrand: toRank(byBrand),
      bySize: toRank(bySize).map(({ key, label, net, units }) => ({ size: label, sold: units, net })),
      discounts: [...discountRows.values()].sort((a, b) => b.amount - a.amount),
      returns: returnRows.map((r) => ({
        id: r.id,
        number: r.number,
        orderNumber: r.order.number,
        reason: r.reason,
        amount: r.refundAmount,
        createdAt: (r.refundedAt ?? r.createdAt).toISOString(),
      })),
    };
  },

  async listRegisters() {
    const rows = await prisma.posRegister.findMany({
      include: { warehouse: true, sessions: { where: { closedAt: null }, take: 1 } },
      orderBy: [{ locationId: "asc" }, { name: "asc" }],
    });
    const locs = await prisma.pickupLocation.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.locationId))] } },
    });
    const locName = new Map(locs.map((l) => [l.id, l.name]));
    return rows.map((r) => ({
      ...r,
      locationName: locName.get(r.locationId) ?? null,
      openSession: r.sessions[0] ?? null,
      sessions: undefined,
    }));
  },

  async upsertRegister(body: {
    id?: string;
    locationId: string;
    warehouseId: string;
    name: string;
    device?: string;
    printer?: string;
    terminalId?: string;
    drawer?: boolean;
    scanner?: string;
    active?: boolean;
  }) {
    if (body.id) {
      const before = await prisma.posRegister.findUnique({ where: { id: body.id } });
      if (!before) throw ApiError.notFound("Register");
      return prisma.posRegister.update({
        where: { id: body.id },
        data: {
          locationId: body.locationId,
          warehouseId: body.warehouseId,
          name: body.name,
          device: body.device,
          printer: body.printer,
          terminalId: body.terminalId,
          drawer: body.drawer,
          scanner: body.scanner,
          active: body.active,
        },
      });
    }
    return prisma.posRegister.create({
      data: {
        locationId: body.locationId,
        warehouseId: body.warehouseId,
        name: body.name,
        device: body.device,
        printer: body.printer,
        terminalId: body.terminalId,
        drawer: body.drawer ?? true,
        scanner: body.scanner,
        active: body.active ?? true,
      },
    });
  },

  async listSessions(q: { page: number; pageSize: number; registerId?: string; open?: boolean }) {
    const where = {
      ...(q.registerId ? { registerId: q.registerId } : {}),
      ...(q.open === true ? { closedAt: null } : q.open === false ? { closedAt: { not: null } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.posRegisterSession.findMany({
        where,
        include: { register: true, moves: true },
        orderBy: { openedAt: "desc" },
        ...paging(q),
      }),
      prisma.posRegisterSession.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async audit(q: { page: number; pageSize: number; locationId?: string; action?: string; from?: string; to?: string }) {
    const where = {
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.from || q.to
        ? { at: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.posAuditEvent.findMany({ where, orderBy: { at: "desc" }, ...paging(q) }),
      prisma.posAuditEvent.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async listPromotions() {
    return prisma.posPromotion.findMany({ orderBy: { startsAt: "desc" } });
  },

  async createPromotion(body: {
    name: string;
    label: string;
    kind: PosPromo["kind"];
    buy?: number;
    get?: number;
    value: number;
    minSpend?: number;
    scope?: PosPromo["scope"];
    channels?: string[];
    stores?: string[];
    startsAt: string;
    endsAt: string;
    active?: boolean;
  }) {
    return posPromotionsService.create(body);
  },

  async updatePromotion(
    id: string,
    patch: Partial<{
      name: string;
      label: string;
      kind: PosPromo["kind"];
      buy: number | null;
      get: number | null;
      value: number;
      minSpend: number | null;
      scope: PosPromo["scope"];
      channels: string[];
      stores: string[];
      startsAt: string;
      endsAt: string;
      active: boolean;
    }>,
  ) {
    const before = await prisma.posPromotion.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Promotion");
    return prisma.posPromotion.update({
      where: { id },
      data: {
        ...patch,
        scope: patch.scope as Prisma.InputJsonValue | undefined,
        channels: patch.channels as Prisma.InputJsonValue | undefined,
        stores: patch.stores as Prisma.InputJsonValue | undefined,
        startsAt: patch.startsAt ? new Date(patch.startsAt) : undefined,
        endsAt: patch.endsAt ? new Date(patch.endsAt) : undefined,
      },
    });
  },

  async deletePromotion(id: string) {
    const row = await prisma.posPromotion.findUnique({ where: { id } });
    if (!row) throw ApiError.notFound("Promotion");
    await prisma.posPromotion.delete({ where: { id } });
    return row;
  },

  async stockMoves(q: { page: number; pageSize: number; warehouseId?: string }) {
    const [transfers, counts, grn] = await Promise.all([
      prisma.posStockTransfer.findMany({
        where: q.warehouseId
          ? { OR: [{ fromWarehouseId: q.warehouseId }, { toWarehouseId: q.warehouseId }] }
          : undefined,
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.posStockCount.findMany({
        where: q.warehouseId ? { warehouseId: q.warehouseId } : undefined,
        orderBy: { at: "desc" },
        take: 20,
      }),
      prisma.posGoodsReceipt.findMany({
        where: q.warehouseId ? { warehouseId: q.warehouseId } : undefined,
        orderBy: { expectedAt: "desc" },
        take: 20,
      }),
    ]);
    void q.page;
    void q.pageSize;
    return { transfers, counts, grn };
  },

  async settings() {
    return settingsService.get("pos");
  },

  async updateSettings(patch: Record<string, unknown>, by: string) {
    return settingsService.update("pos", patch as never, by);
  },

  async listStaff() {
    const rows = await prisma.adminUser.findMany({
      where: { role: { in: [...STORE_ROLES] } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        locationIds: true,
        pinHash: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.status,
      locationIds: Array.isArray(r.locationIds) ? (r.locationIds as string[]) : [],
      hasPin: !!r.pinHash,
      discountLimitPct: POS_DISCOUNT_LIMITS[r.role as keyof typeof POS_DISCOUNT_LIMITS] ?? 0,
      permissions: ROLE_PERMISSIONS[r.role] ?? [],
      createdAt: r.createdAt,
    }));
  },

  async upsertStaff(body: AdminStaffBody) {
    const pinHash = body.pin ? await hashPassword(body.pin) : undefined;
    if (body.id) {
      const before = await prisma.adminUser.findUnique({ where: { id: body.id } });
      if (!before) throw ApiError.notFound("Staff");
      if (!STORE_ROLES.includes(before.role as (typeof STORE_ROLES)[number]) && !STORE_ROLES.includes(body.role)) {
        throw ApiError.badRequest("VALIDATION_FAILED", "Only store roles can be managed here.");
      }
      return prisma.adminUser.update({
        where: { id: body.id },
        data: {
          name: body.name,
          email: body.email,
          role: body.role,
          locationIds: body.locationIds as Prisma.InputJsonValue,
          status: body.active ? "active" : "suspended",
          ...(pinHash ? { pinHash } : {}),
        },
        select: { id: true, name: true, email: true, role: true, status: true, locationIds: true },
      });
    }
    const existing = await prisma.adminUser.findUnique({ where: { email: body.email } });
    if (existing) throw ApiError.conflict("EMAIL_TAKEN", "That email is already on the team.");
    if (!pinHash) throw ApiError.badRequest("VALIDATION_FAILED", "Set a 4-digit till PIN.");
    return prisma.adminUser.create({
      data: {
        name: body.name,
        email: body.email,
        role: body.role,
        locationIds: body.locationIds as Prisma.InputJsonValue,
        status: body.active ? "active" : "suspended",
        pinHash,
        passwordHash: await hashPassword(`pos-${body.email}-${Date.now()}`),
      },
      select: { id: true, name: true, email: true, role: true, status: true, locationIds: true },
    });
  },

  listLocations() {
    return pickupsService.listLocations();
  },

  async updateLocation(id: string, body: AdminLocationPatch) {
    const out = await pickupsService.updateLocation(id, body);
    return out.after;
  },

  listWarehouses() {
    return warehousesService.list();
  },

  async listCoupons() {
    const rows = await prisma.coupon.findMany({
      where: { status: { in: ["active", "scheduled", "paused"] } },
      orderBy: { code: "asc" },
      take: 200,
    });
    return rows.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      type: c.type,
      value: c.value,
      status: c.status,
      minSubtotal: c.minSubtotal,
      maxDiscount: c.maxDiscount,
      channels: Array.isArray(c.channels) ? (c.channels as string[]) : [],
      endsAt: c.endsAt,
    }));
  },

  async patchCouponChannels(id: string, body: AdminCouponChannelsPatch) {
    const c = await prisma.coupon.findUnique({ where: { id } });
    if (!c) throw ApiError.notFound("Coupon");
    return prisma.coupon.update({
      where: { id },
      data: { channels: body.channels as Prisma.InputJsonValue },
      select: { id: true, code: true, channels: true, status: true },
    });
  },
};
