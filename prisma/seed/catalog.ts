/**
 * Ports the prototype's mock catalogue (asl-web shop-data + admin stores) into the database,
 * so all three apps show the same products on day one of switching to the API.
 * Data fixes applied while porting are listed in docs/DECISIONS.md (D-DATA).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { mediaService } from "../../src/modules/content/media/media.service";
import { slugify } from "../../src/core/utils/slug";

const dir = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(dir, "data/catalog.json"), "utf8"));
const K = (naira: number) => Math.round(naira * 100);

/** UI data fixes (see DECISIONS.md) */
const BRAND_FIX: Record<string, string> = {
  Nike: "NIKE",
  Dior: "DIOR",
  ESSENTIALS: "FEAR OF GOD ESSENTIALS",
  "CARGO TROUSERS": "ASL ORIGINALS",
};
const PRODUCT_BRAND_FIX: Record<string, string> = { fr5: "CHANEL" }; // "Bleu de Chanel" was listed under DIOR

const AVAIL: Record<string, "in_stock" | "pre_order" | "limited" | "restocked"> = {
  "In Stock": "in_stock", "Pre Order": "pre_order", "Limited Pieces": "limited", Restocked: "restocked",
};

export async function seedCatalog(prisma: PrismaClient, log = console.log) {
  if ((await prisma.product.count()) > 0) return log("catalog: already seeded, skipping");

  // ── images: upload each asset once into the media library ──
  const urls = new Map<string, string>();
  async function asset(ref?: string | null, folder = "products") {
    if (!ref?.startsWith("asset:")) return ref ?? null;
    const name = ref.slice(6);
    if (urls.has(name)) return urls.get(name)!;
    const buffer = fs.readFileSync(path.join(dir, "assets", name));
    const a = await mediaService.upload({ buffer, originalname: name, mimetype: "image/webp", size: buffer.length }, folder, "seed");
    urls.set(name, a.url);
    return a.url;
  }

  // ── warehouses ──
  const wh = new Map<string, string>();
  for (const w of data.warehouses) {
    const row = await prisma.warehouse.upsert({ where: { code: w.code }, create: { name: w.name, code: w.code, city: w.city, isDefault: w.id === "lag" }, update: {} });
    wh.set(w.id, row.id);
  }
  await prisma.warehouse.updateMany({ where: { code: "LOS-01" }, data: { isDefault: false, active: false } });
  await prisma.warehouse.update({ where: { code: "LAG-01" }, data: { isDefault: true } });

  // ── categories (+ subcategories; the UI's "All …" entries are filters, not data) ──
  const catByHandle = new Map<string, string>();
  const subByName = new Map<string, string>();
  for (const c of data.adminCategories) {
    const row = await prisma.category.create({
      data: {
        name: c.name, handle: c.handle, description: c.description, status: c.status, featured: c.featured, position: c.order,
        imageUrl: await asset(data.subThumbs?.[c.handle]?.[`All ${c.handle}`] ?? null),
        seoTitle: c.seoTitle, seoDescription: c.seoDescription,
        subcategories: {
          create: c.subcategories
            .filter((s: any) => !/^All /.test(s.name))
            .map((s: any, i: number) => ({ name: s.name, handle: slugify(s.name), status: s.status, position: i })),
        },
      },
      include: { subcategories: true },
    });
    catByHandle.set(c.handle, row.id);
    for (const s of row.subcategories) {
      subByName.set(`${c.handle}:${s.name}`, s.id);
      const thumb = data.subThumbs?.[c.handle]?.[s.name];
      if (thumb) await prisma.subcategory.update({ where: { id: s.id }, data: { imageUrl: await asset(thumb) } });
    }
  }

  // ── brands: admin brand records + every brand used by a product ──
  const brandMeta = new Map<string, any>(data.brands.map((b: any) => [b.name.toUpperCase(), b]));
  const brandNames = new Set<string>(data.products.map((p: any) => PRODUCT_BRAND_FIX[p.id] ?? BRAND_FIX[p.brand] ?? p.brand));
  for (const b of data.brands) brandNames.add(b.name);
  const brandId = new Map<string, string>();
  for (const name of [...brandNames].sort()) {
    const m = brandMeta.get(name.toUpperCase());
    const row = await prisma.brand.create({
      data: {
        name, handle: m?.handle ?? slugify(name), tagline: m?.tagline, description: m?.description, country: m?.country,
        tier: m?.tier ?? "core", status: m?.status ?? "active", featured: m?.featured ?? false, conciergeOnly: m?.concierge_only ?? false,
        logoInitial: m?.logoInitial ?? name.slice(0, 2).toUpperCase(), accent: m?.accent, website: m?.website,
        seoTitle: m?.seoTitle, seoDescription: m?.seoDescription,
      },
    });
    brandId.set(name, row.id);
  }

  // ── products ──
  const bestIdx = new Map<string, number>(data.products.filter((p: any) => p.bestSeller).map((p: any, i: number) => [p.id, i]));
  const trendIdx = new Map<string, number>(data.products.filter((p: any) => p.trending).map((p: any, i: number) => [p.id, i]));
  const newIdx = new Map<string, number>(data.newArrivals.map((id: string, i: number) => [id, i]));
  const inv = data.inventory as { sku: string; productId: string; variant: string; warehouseId: string; onHand: number; reserved: number; reorderPoint: number; cost: number }[];
  const now = Date.now();

  for (const p of data.products) {
    const brand = PRODUCT_BRAND_FIX[p.id] ?? BRAND_FIX[p.brand] ?? p.brand;
    const sizing = data.sizing[p.id];
    const gallery: string[] = [];
    for (const g of p.gallery?.length ? p.gallery : [p.image]) {
      const u = await asset(g);
      if (u && !gallery.includes(u)) gallery.push(u);
    }
    const original = p.sale?.originalPrice ?? p.originalPrice;
    const sizes: string[] = p.sizes?.length ? p.sizes : [];
    const colors: { name: string; hex: string }[] = p.colors ?? [];
    const multiColor = colors.length > 1;
    const product = await prisma.product.create({
      data: {
        handle: p.id,
        name: p.name,
        brandId: brandId.get(brand)!,
        categoryId: catByHandle.get(p.category)!,
        subcategoryId: p.subcategory ? subByName.get(`${p.category}:${p.subcategory}`) ?? null : null,
        price: K(p.price),
        compareAtPrice: original && original > p.price ? K(original) : null,
        cost: inv.find((r) => r.productId === p.id)?.cost ? K(inv.find((r) => r.productId === p.id)!.cost) : Math.round(K(p.price) * 0.42),
        description: p.copy?.description ?? p.description ?? null,
        styleCode: p.copy?.styleCode ?? p.styleCode ?? null,
        availability: AVAIL[p.availability] ?? "in_stock",
        status: "active",
        isConcierge: !!p.concierge,
        priceOnRequest: !!p.priceOnRequest,
        modelFit: sizing?.modelFit ?? p.modelFit ?? null,
        bestSellerScore: bestIdx.has(p.id) ? 1000 - bestIdx.get(p.id)! : 0,
        trendingScore: trendIdx.has(p.id) ? 1000 - trendIdx.get(p.id)! : 0,
        featured: bestIdx.has(p.id),
        publishedAt: new Date(now - (newIdx.get(p.id) ?? 60) * 86_400_000),
        images: { create: gallery.map((url, i) => ({ url, position: i, alt: `${brand} ${p.name}` })) },
        colors: { create: colors.map((c, i) => ({ name: c.name, hex: c.hex, position: i })) },
        features: { create: (p.copy?.features ?? p.features ?? []).map((text: string, i: number) => ({ text, position: i })) },
        sizeLabels: { create: Object.entries((sizing?.sizeLabels ?? p.sizeLabelsOverride ?? {}) as Record<string, string>).map(([size, label]) => ({ size, label })) },
      },
    });
    await mediaService.syncUsage("product", product.id, gallery);

    // variants (size × colour) + stock from the prototype inventory
    const vs = (sizes.length ? sizes : [null]).flatMap((size, i) => (multiColor ? colors.map((c) => c.name) : [null]).map((color, j) => ({ size, color, position: i * 100 + j })));
    for (const v of vs) {
      const sku = [p.id, v.size, v.color].filter(Boolean).join("-").toUpperCase().replace(/[^A-Z0-9-]+/g, "");
      const variant = await prisma.productVariant.create({ data: { productId: product.id, sku, size: v.size, color: v.color, position: v.position } });
      const soldOut = p.outOfStock || (v.size && p.sizeAvailability?.[v.size] === false);
      const rows = inv.filter((r) => r.productId === p.id && (r.variant === (v.size ?? "OS") || (!v.size && inv.filter((x) => x.productId === p.id).length === 1)));
      const perColor = multiColor ? colors.length : 1;
      if (rows.length) {
        // the prototype inventory can list the same SKU twice per warehouse → merge
        const byWh = new Map<string, { onHand: number; reorderPoint: number; cost: number }>();
        for (const r of rows) {
          const cur = byWh.get(r.warehouseId);
          byWh.set(r.warehouseId, { onHand: (cur?.onHand ?? 0) + r.onHand, reorderPoint: Math.max(cur?.reorderPoint ?? 0, r.reorderPoint), cost: r.cost });
        }
        for (const [w, r] of byWh)
          await prisma.stockLevel.create({
            data: {
              variantId: variant.id, warehouseId: wh.get(w)!, onHand: soldOut ? 0 : Math.max(1, Math.round(r.onHand / perColor)),
              reorderPoint: r.reorderPoint, cost: K(r.cost),
            },
          });
      } else {
        await prisma.stockLevel.create({ data: { variantId: variant.id, warehouseId: wh.get("lag")!, onHand: soldOut ? 0 : 6, reorderPoint: 2 } });
      }
    }
  }

  // ── collections ──
  const handleToId = new Map((await prisma.product.findMany({ select: { id: true, handle: true } })).map((r) => [r.handle, r.id]));
  for (const c of data.collections) {
    await prisma.collection.create({
      data: {
        title: c.title, handle: c.handle, description: c.description, status: c.status, type: c.type, slot: c.slot,
        rules: (c.rules ?? []).map((r: any) => (r.field === "price" ? { ...r, value: String(K(Number(r.value))) } : r)),
        coverUrl: await asset(c.coverImage, "campaigns"), featured: c.featured, sortOrder: c.sortOrder, tags: c.tags,
        publishedAt: c.status === "active" ? new Date() : null,
        products: { create: (c.productIds ?? []).filter((h: string) => handleToId.has(h)).map((h: string, i: number) => ({ productId: handleToId.get(h)!, position: i })) },
      },
    });
  }

  // ── size guides ──
  for (const g of data.sizeGuides)
    await prisma.sizeGuide.upsert({ where: { scope_target: { scope: g.scope, target: g.target } }, create: { scope: g.scope, target: g.target, note: g.note }, update: {} });

  // ── drops: the prototype dates are in the past → reschedule into the coming weeks ──
  for (const [i, d] of data.drops.entries()) {
    const pid = handleToId.get(d.product.id);
    if (!pid) continue;
    await prisma.drop.create({
      data: {
        productId: pid, releaseAt: new Date(now + (i * 5 + 4) * 86_400_000), allocation: d.allocation,
        reservedCount: Math.min(d.reservedCount, d.allocation - 2), teaser: d.teaser, depositPct: 20, status: "upcoming",
      },
    });
  }

  // ── reviews (prototype moderation queue) ──
  const FIT: Record<string, "runs_small" | "true_to_size" | "runs_large"> = { "Runs small": "runs_small", "True to size": "true_to_size", "Runs large": "runs_large" };
  for (const r of data.reviews) {
    const pid = handleToId.get(r.productId);
    if (!pid) continue;
    const created = Date.parse(r.date);
    await prisma.review.create({
      data: {
        productId: pid, authorName: r.author, rating: r.rating, title: r.title, body: r.body, size: r.size, fit: r.fit ? FIT[r.fit] : undefined,
        verified: r.verified, status: r.status, flaggedReason: r.flaggedReason, helpfulCount: r.helpful ?? 0, reportedCount: r.reportedCount ?? 0,
        replyBody: r.reply?.body, replyAuthor: r.reply?.author, repliedAt: r.reply ? new Date(r.reply.at) : null,
        createdAt: Number.isFinite(created) ? new Date(created) : new Date(),
      },
    });
  }
  for (const id of handleToId.values()) {
    const agg = await prisma.review.aggregate({ where: { productId: id, status: "published" }, _avg: { rating: true }, _count: true });
    await prisma.product.update({ where: { id }, data: { ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10, ratingCount: agg._count } });
  }

  log(`catalog: ${handleToId.size} products, ${brandId.size} brands, ${catByHandle.size} categories, ${data.collections.length} collections, ${urls.size} images`);
}
