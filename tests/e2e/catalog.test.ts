import { beforeAll, describe, expect, it } from "vitest";
import { api, bearer, createAdmin, registerCustomer } from "../setup/helpers";
import { resetDb } from "../setup/db";
import { prisma } from "@/core/db/prisma";
import { seedCatalog } from "../../prisma/seed/catalog";
import { inventoryService } from "@/modules/inventory/inventory.service";

const S = "/api/v1/store";
const A = "/api/v1/admin";
let admin: string;

beforeAll(async () => {
  await resetDb();
  await seedCatalog(prisma, () => undefined);
  admin = (await createAdmin("super_admin")).token;
}, 180_000);

describe("storefront catalogue", () => {
  it("lists with category filter, pagination and sort", async () => {
    const r = await api().get(`${S}/products?category=footwear&sort=price_asc&pageSize=5`);
    expect(r.status).toBe(200);
    expect(r.body.meta.total).toBe(15);
    expect(r.body.data).toHaveLength(5);
    const prices = r.body.data.map((p: any) => p.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    expect(r.body.data.every((p: any) => p.category === "footwear")).toBe(true);
  });

  it("filters by brand list, size, price range and sale", async () => {
    const nike = await api().get(`${S}/products?brand=nike&pageSize=50`);
    expect(nike.body.data.length).toBeGreaterThan(3);
    expect(nike.body.data.every((p: any) => p.brand === "NIKE")).toBe(true);
    const sized = await api().get(`${S}/products?size=XL&category=clothing&pageSize=50`);
    expect(sized.body.data.every((p: any) => p.sizes.includes("XL"))).toBe(true);
    const range = await api().get(`${S}/products?minPrice=10000000&maxPrice=25000000&pageSize=50`);
    expect(range.body.data.every((p: any) => p.price >= 10_000_000 && p.price <= 25_000_000)).toBe(true);
    const sale = await api().get(`${S}/products?category=sale&pageSize=50`);
    expect(sale.body.data.length).toBeGreaterThan(0);
    expect(sale.body.data.every((p: any) => p.originalPrice > p.price && p.discountPct > 0)).toBe(true);
  });

  it("facets give counts for the filter sheet", async () => {
    const f = await api().get(`${S}/products/facets?category=clothing`);
    expect(f.body.data.total).toBe(19);
    expect(f.body.data.brands.length).toBeGreaterThan(3);
    expect(f.body.data.priceRanges.reduce((n: number, b: any) => n + b.count, 0)).toBe(19);
  });

  it("product page has gallery, sizes, size availability, features", async () => {
    const r = await api().get(`${S}/products/c1`);
    expect(r.status).toBe(200);
    const p = r.body.data;
    expect(p.price).toBe(5_500_000);
    expect(p.sizes).toEqual(["S", "M", "L", "XL"]);
    expect(p.sizeAvailability.S).toBe(false); // sold-out size in the prototype
    expect(p.gallery.length).toBeGreaterThan(1);
    expect(p.features.length).toBeGreaterThan(0);
    expect((await api().get(`${S}/products/c1/related`)).body.data.length).toBe(4);
    expect((await api().get(`${S}/products/does-not-exist`)).status).toBe(404);
  });

  it("home returns every section in one call", async () => {
    const r = await api().get(`${S}/home`);
    expect(r.body.data.bestSellers.length).toBe(8);
    expect(r.body.data.categories.map((c: any) => c.handle)).toEqual(["clothing", "footwear", "accessories", "fragrances"]);
  });

  it("categories include the virtual Sale category; brands directory has counts", async () => {
    const c = await api().get(`${S}/categories`);
    expect(c.body.data.at(-1).handle).toBe("sale");
    expect(c.body.data.find((x: any) => x.handle === "clothing").subcategories.some((s: any) => s.name.startsWith("All "))).toBe(false);
    const b = await api().get(`${S}/brands`);
    expect(b.body.data.every((x: any) => x.itemCount > 0)).toBe(true);
    expect(b.body.data.map((x: any) => x.name)).not.toContain("CARGO TROUSERS");
  });

  it("smart collection resolves rules; scheduled collections stay hidden", async () => {
    const r = await api().get(`${S}/collections/footwear-icons`);
    expect(r.body.data.products.length).toBe(15);
    expect(r.body.data.products.every((p: any) => p.category === "footwear")).toBe(true);
    expect((await api().get(`${S}/collections/gifts-under-500k`)).status).toBe(404);
    const prev = await api().get(`${A}/collections/gifts-under-500k/preview`).set(bearer(admin));
    expect(prev.body.data.every((p: any) => p.price < 50_000_000)).toBe(true);
  });

  it("search returns products + brands and feeds popular searches", async () => {
    for (let i = 0; i < 3; i++) await api().get(`${S}/search?q=dunk`);
    const s = await api().get(`${S}/search?q=dunk`);
    expect(s.body.data.total).toBeGreaterThan(0);
    const pop = await api().get(`${S}/search/popular`);
    expect(pop.body.data[0]).toBe("Dunk");
  });
});

describe("admin catalogue", () => {
  it("creates a product with generated variants + stock rows, publishes it, storefront sees it", async () => {
    const brand = (await api().get(`${A}/brands?q=AMIRI`).set(bearer(admin))).body.data[0];
    const cat = (await api().get(`${A}/categories`).set(bearer(admin))).body.data.find((c: any) => c.handle === "clothing");
    const create = await api().post(`${A}/products`).set(bearer(admin)).send({
      name: "Bones Runner Tee", brandId: brand.id, categoryId: cat.id, price: 12_000_000, sizes: ["S", "M"], colors: [{ name: "Black", hex: "#000" }, { name: "White", hex: "#fff" }],
      images: [{ url: "https://cdn.example/x.webp" }], features: ["Heavyweight cotton"],
    });
    expect(create.status).toBe(201);
    const p = create.body.data;
    expect(p.status).toBe("draft");
    expect(p.variants).toHaveLength(4);
    expect(await prisma.stockLevel.count({ where: { variant: { productId: p.productId } } })).toBe(4);
    expect((await api().get(`${S}/products/${p.id}`)).status).toBe(404); // draft hidden
    await api().patch(`${A}/products/${p.id}/status`).set(bearer(admin)).send({ status: "active" }).expect(200);
    expect((await api().get(`${S}/products/${p.id}`)).status).toBe(200);
    // removing a size deactivates (does not delete) its variants
    const upd = await api().patch(`${A}/products/${p.id}`).set(bearer(admin)).send({ sizes: ["M"] });
    expect(upd.body.data.variants).toHaveLength(2);
    expect(await prisma.productVariant.count({ where: { productId: p.productId } })).toBe(4);
    const audit = await prisma.auditEvent.findFirst({ where: { action: "product.updated", entityId: p.productId } });
    expect(audit?.summary).toContain("Bones Runner Tee");
  });

  it("duplicate, bulk archive and soft delete", async () => {
    const dup = await api().post(`${A}/products/c2/duplicate`).set(bearer(admin));
    expect(dup.status).toBe(201);
    expect(dup.body.data.name).toContain("(Copy)");
    await api().post(`${A}/products/bulk`).set(bearer(admin)).send({ ids: ["c3", "c4"], action: "archive" }).expect(200);
    expect((await api().get(`${S}/products/c3`)).status).toBe(404);
    await api().delete(`${A}/products/c5`).set(bearer(admin)).expect(200);
    expect((await api().get(`${A}/products/c5`).set(bearer(admin))).status).toBe(404);
    expect(await prisma.product.count({ where: { deletedAt: { not: null } } })).toBe(1);
  });

  it("content editor can view but not edit products", async () => {
    const { token } = await createAdmin("content_editor");
    expect((await api().get(`${A}/products`).set(bearer(token))).status).toBe(200);
    expect((await api().patch(`${A}/products/c1`).set(bearer(token)).send({ name: "x" })).status).toBe(403);
  });

  it("category with products can't be deleted; subcategory CRUD", async () => {
    const cats = (await api().get(`${A}/categories`).set(bearer(admin))).body.data;
    const clothing = cats.find((c: any) => c.handle === "clothing");
    expect((await api().delete(`${A}/categories/${clothing.id}`).set(bearer(admin))).body.error.code).toBe("CONFLICT");
    const added = await api().post(`${A}/categories/${clothing.id}/subcategories`).set(bearer(admin)).send({ name: "Knitwear" });
    const sub = added.body.data.subcategories.find((s: any) => s.name === "Knitwear");
    await api().delete(`${A}/categories/${clothing.id}/subcategories/${sub.id}`).set(bearer(admin)).expect(200);
  });
});

describe("reviews", () => {
  it("customer review is pending → admin publishes → rating recomputed; helpful counted once", async () => {
    const { token } = await registerCustomer();
    const before = (await api().get(`${S}/products/f1`)).body.data.rating;
    const w = await api().post(`${S}/products/f1/reviews`).set(bearer(token)).field("rating", "1").field("title", "Not for me").field("body", "Runs very small and the sole squeaks.");
    expect(w.status).toBe(201);
    expect(w.body.data.status).toBe("pending");
    expect(w.body.data.verified).toBe(false);
    const dup = await api().post(`${S}/products/f1/reviews`).set(bearer(token)).field("rating", "5").field("title", "Again").field("body", "Second attempt at reviewing.");
    expect(dup.status).toBe(409);
    await api().patch(`${A}/reviews/${w.body.data.id}/status`).set(bearer(admin)).send({ status: "published" }).expect(200);
    const after = (await api().get(`${S}/products/f1`)).body.data.rating;
    expect(after.count).toBe(before.count + 1);
    expect(after.average).toBeLessThan(before.average || 6);
    expect((await api().post(`${S}/reviews/${w.body.data.id}/helpful`).set(bearer(token))).body.data.counted).toBe(true);
    expect((await api().post(`${S}/reviews/${w.body.data.id}/helpful`).set(bearer(token))).body.data.counted).toBe(false);
    const list = await api().get(`${S}/products/f1/reviews`);
    expect(list.body.data.summary.distribution.find((d: any) => d.star === 1).count).toBeGreaterThan(0);
  });
});

describe("inventory", () => {
  it("adjust, low-stock state, transfer, cannot drop below reserved", async () => {
    const list = await api().get(`${A}/inventory?q=F2-&pageSize=100`).set(bearer(admin));
    const row = list.body.data[0];
    await api().post(`${A}/inventory/adjust`).set(bearer(admin)).send({ sku: row.sku, warehouseId: row.warehouseId, delta: 10, note: "Delivery" }).expect(200);
    const wh = (await api().get(`${A}/warehouses`).set(bearer(admin))).body.data;
    const other = wh.find((w: any) => w.id !== row.warehouseId && w.active);
    await api().post(`${A}/inventory/transfer`).set(bearer(admin)).send({ sku: row.sku, from: row.warehouseId, to: other.id, qty: 3 }).expect(200);
    const tooMuch = await api().post(`${A}/inventory/adjust`).set(bearer(admin)).send({ sku: row.sku, warehouseId: row.warehouseId, delta: -100000, note: "oops" });
    expect(tooMuch.body.error.code).toBe("INVALID_STATE");
    const mv = await api().get(`${A}/inventory/movements?sku=${row.sku}`).set(bearer(admin));
    expect(mv.body.data.map((m: any) => m.type)).toEqual(expect.arrayContaining(["adjust", "transfer_out", "transfer_in"]));
  });

  it("concurrent reservations never oversell the last units", async () => {
    const v = await prisma.productVariant.findFirstOrThrow({ where: { product: { handle: "f2" } } });
    await prisma.stockLevel.updateMany({ where: { variantId: v.id }, data: { onHand: 0, reserved: 0 } });
    const lag = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
    await prisma.stockLevel.update({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: lag.id } }, data: { onHand: 3 } });
    const attempts = Array.from({ length: 12 }, (_, i) =>
      prisma.$transaction((tx) => inventoryService.reserve(tx, [{ variantId: v.id, qty: 1 }], { type: "test", id: `o${i}` })).then(() => "ok", (e) => e.code),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "OUT_OF_STOCK")).toHaveLength(9);
    const level = await prisma.stockLevel.findUniqueOrThrow({ where: { variantId_warehouseId: { variantId: v.id, warehouseId: lag.id } } });
    expect(level.reserved).toBe(3);
  });
});
