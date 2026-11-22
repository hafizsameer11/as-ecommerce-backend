import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { pointsService } from "@/modules/loyalty/club/points.service";
import type { CatalogQuery, CreateCustomerBody, CustomersQuery } from "./pos.schemas";

export const posCatalogService = {
  async catalog(q: CatalogQuery, warehouseId?: string) {
    if (q.barcode || q.sku) {
      const code = q.sku || q.barcode;
      const v = await prisma.productVariant.findFirst({
        where: {
          active: true,
          sku: code,
          product: { status: "active", deletedAt: null },
        },
        include: {
          product: {
            include: {
              brand: true,
              category: true,
              images: { orderBy: { position: "asc" }, take: 1 },
              variants: { where: { active: true }, orderBy: { position: "asc" } },
            },
          },
        },
      });
      if (!v) return withMeta([], pageMeta(q, 0));
      const stock = warehouseId
        ? await prisma.stockLevel.findMany({ where: { variantId: { in: v.product.variants.map((x) => x.id) } } })
        : [];
      return withMeta([mapProduct(v.product, stock, warehouseId)], pageMeta(q, 1));
    }

    const where: Prisma.ProductWhereInput = {
      status: "active",
      deletedAt: null,
      ...(q.category ? { category: { OR: [{ handle: q.category }, { name: q.category }] } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q } },
              { handle: { contains: q.q } },
              { brand: { name: { contains: q.q } } },
              { variants: { some: { sku: { contains: q.q } } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          brand: true,
          category: true,
          images: { orderBy: { position: "asc" }, take: 1 },
          variants: { where: { active: true }, orderBy: { position: "asc" } },
        },
        orderBy: { name: "asc" },
        ...paging(q),
      }),
      prisma.product.count({ where }),
    ]);
    const variantIds = rows.flatMap((p) => p.variants.map((v) => v.id));
    const stock = variantIds.length
      ? await prisma.stockLevel.findMany({ where: { variantId: { in: variantIds } } })
      : [];
    return withMeta(rows.map((p) => mapProduct(p, stock, warehouseId)), pageMeta(q, total));
  },

  async product(idOrHandle: string, warehouseId?: string) {
    const p = await prisma.product.findFirst({
      where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }], status: "active", deletedAt: null },
      include: {
        brand: true,
        category: true,
        images: { orderBy: { position: "asc" }, take: 4 },
        variants: { where: { active: true }, orderBy: { position: "asc" } },
        sizeLabels: true,
      },
    });
    if (!p) throw ApiError.notFound("Product");
    const stock = await prisma.stockLevel.findMany({ where: { variantId: { in: p.variants.map((v) => v.id) } } });
    return mapProduct(p, stock, warehouseId);
  },

  async searchCustomers(q: CustomersQuery) {
    const term = q.q;
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null,
      OR: [
        { email: { contains: term } },
        { phone: { contains: term } },
        { firstName: { contains: term } },
        { lastName: { contains: term } },
      ],
    };
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        include: { wallet: true, stats: true },
        orderBy: { updatedAt: "desc" },
        ...paging(q),
      }),
      prisma.customer.count({ where }),
    ]);
    const pts = await pointsService.availableMany(rows.map((c) => c.id));
    return withMeta(
      rows.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        email: c.email,
        phone: c.phone,
        tier: c.tier,
        loyaltyPoints: pts.get(c.id) ?? 0,
        walletBalance: c.wallet?.balance ?? 0,
        spend: c.stats?.totalSpend != null ? Number(c.stats.totalSpend) : 0,
        orders: c.stats?.ordersCount ?? 0,
      })),
      pageMeta(q, total),
    );
  },

  async createCustomer(body: CreateCustomerBody) {
    if (!body.email && !body.phone) throw ApiError.badRequest("VALIDATION_FAILED", "Give an e-mail or phone number.");
    if (body.email) {
      const exists = await prisma.customer.findUnique({ where: { email: body.email } });
      if (exists) throw ApiError.conflict("EMAIL_TAKEN", "A customer with that e-mail already exists.");
    }
    const c = await prisma.customer.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName ?? "",
        email: body.email ?? `walkin+${Date.now()}@pos.asloriginals.local`,
        phone: body.phone,
        emailVerifiedAt: body.email ? null : new Date(),
        status: "active",
        tier: "Standard",
        wallet: { create: {} },
        stats: { create: {} },
      },
      include: { wallet: true, stats: true },
    });
    return {
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(" "),
      email: c.email,
      phone: c.phone,
      tier: c.tier,
      loyaltyPoints: 0,
      walletBalance: c.wallet?.balance ?? 0,
      spend: 0,
      orders: 0,
      walkIn: !body.email,
    };
  },
};

function mapProduct(
  p: {
    id: string;
    handle: string;
    name: string;
    price: number;
    compareAtPrice: number | null;
    priceOnRequest: boolean;
    availability: string;
    brand: { name: string };
    category: { name: string; handle: string };
    images: { url: string }[];
    variants: { id: string; sku: string; size: string | null; color: string | null; price: number | null; active: boolean }[];
    sizeLabels?: { size: string; label: string }[];
  },
  stock: { variantId: string; warehouseId: string; onHand: number; reserved: number }[],
  warehouseId?: string,
) {
  const byVariant = (vid: string) => {
    const rows = stock.filter((s) => s.variantId === vid);
    const here = warehouseId ? rows.find((s) => s.warehouseId === warehouseId) : null;
    return {
      here: here ? here.onHand - here.reserved : null,
      locations: rows.map((s) => ({
        warehouseId: s.warehouseId,
        available: s.onHand - s.reserved,
        onHand: s.onHand,
        reserved: s.reserved,
      })),
    };
  };
  return {
    id: p.id,
    handle: p.handle,
    name: p.name,
    brand: p.brand.name,
    category: p.category.name,
    categoryHandle: p.category.handle,
    image: p.images[0]?.url ?? null,
    price: p.price,
    compareAt: p.compareAtPrice,
    priceOnRequest: p.priceOnRequest,
    availability: p.availability,
    sizeLabels: Object.fromEntries((p.sizeLabels ?? []).map((s) => [s.size, s.label])),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      barcode: v.sku,
      size: v.size,
      color: v.color,
      price: v.price ?? p.price,
      stock: byVariant(v.id),
    })),
  };
}
