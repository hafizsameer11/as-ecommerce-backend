import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { slugify } from "@/core/utils/slug";

export type BrandInput = Partial<{
  name: string; handle: string; tagline: string | null; description: string | null; country: string | null;
  tier: "signature" | "core" | "emerging"; status: "active" | "draft" | "archived"; featured: boolean; conciergeOnly: boolean;
  logoUrl: string | null; logoInitial: string | null; accent: string | null; website: string | null; seoTitle: string | null; seoDescription: string | null;
}>;

async function counts() {
  const rows = await prisma.product.groupBy({ by: ["brandId"], where: { status: "active", deletedAt: null }, _count: true });
  return new Map(rows.map((r) => [r.brandId, r._count]));
}

async function samples(brandIds: string[]) {
  // one representative image per brand for the directory cards
  const rows = await prisma.product.findMany({
    where: { brandId: { in: brandIds }, status: "active", deletedAt: null },
    orderBy: [{ bestSellerScore: "desc" }],
    select: { brandId: true, images: { take: 1, orderBy: { position: "asc" }, select: { url: true } } },
  });
  const m = new Map<string, string>();
  for (const r of rows) if (!m.has(r.brandId) && r.images[0]) m.set(r.brandId, r.images[0].url);
  return m;
}

const dto = (b: Prisma.BrandGetPayload<object>, count: number, image?: string, admin = false) => ({
  id: b.id, handle: b.handle, name: b.name, tagline: b.tagline, description: b.description, country: b.country,
  logoUrl: b.logoUrl, logoInitial: b.logoInitial, accent: b.accent, website: b.website, featured: b.featured,
  itemCount: count, image: image ?? null,
  ...(admin ? { tier: b.tier, status: b.status, conciergeOnly: b.conciergeOnly, seoTitle: b.seoTitle, seoDescription: b.seoDescription, createdAt: b.createdAt, updatedAt: b.updatedAt } : {}),
});

async function find(idOrHandle: string) {
  const b = await prisma.brand.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] } });
  if (!b) throw ApiError.notFound("Brand");
  return b;
}

async function uniqueHandle(base: string, ignoreId?: string) {
  const root = slugify(base) || "brand";
  for (let i = 0; ; i++) {
    const h = i ? `${root}-${i + 1}` : root;
    const hit = await prisma.brand.findUnique({ where: { handle: h } });
    if (!hit || hit.id === ignoreId) return h;
  }
}

export const brandsService = {
  /** /brands directory (A–Z) and /concierge-brands */
  async storeList(opts: { q?: string; concierge?: boolean; featured?: boolean }) {
    const rows = await prisma.brand.findMany({
      where: {
        status: "active",
        featured: opts.featured,
        conciergeOnly: opts.concierge ? undefined : false,
        name: opts.q ? { contains: opts.q } : undefined,
      },
      orderBy: { name: "asc" },
    });
    const [c, img] = await Promise.all([counts(), samples(rows.map((r) => r.id))]);
    const list = rows.map((b) => dto(b, c.get(b.id) ?? 0, img.get(b.id)));
    return opts.concierge ? list : list.filter((b) => b.itemCount > 0);
  },
  async storeGet(handle: string) {
    const b = await find(handle);
    if (b.status !== "active") throw ApiError.notFound("Brand");
    const [c, img] = await Promise.all([counts(), samples([b.id])]);
    return dto(b, c.get(b.id) ?? 0, img.get(b.id));
  },
  async adminList(q: { q?: string; status?: "active" | "draft" | "archived"; tier?: "signature" | "core" | "emerging" }) {
    const rows = await prisma.brand.findMany({ where: { status: q.status, tier: q.tier, name: q.q ? { contains: q.q } : undefined }, orderBy: { name: "asc" } });
    const [c, img] = await Promise.all([counts(), samples(rows.map((r) => r.id))]);
    return rows.map((b) => dto(b, c.get(b.id) ?? 0, img.get(b.id), true));
  },
  async adminGet(id: string) {
    const b = await find(id);
    return dto(b, (await counts()).get(b.id) ?? 0, undefined, true);
  },
  async create(input: BrandInput & { name: string }) {
    if (await prisma.brand.findUnique({ where: { name: input.name } })) throw ApiError.conflict("CONFLICT", "A brand with this name already exists.");
    const b = await prisma.brand.create({
      data: { ...input, name: input.name, handle: await uniqueHandle(input.handle ?? input.name), logoInitial: input.logoInitial ?? input.name.slice(0, 2).toUpperCase() },
    });
    return this.adminGet(b.id);
  },
  async update(id: string, patch: BrandInput) {
    const before = await this.adminGet(id);
    await prisma.brand.update({ where: { id: before.id }, data: { ...patch, handle: patch.handle ? await uniqueHandle(patch.handle, before.id) : undefined } });
    return { before, after: await this.adminGet(before.id) };
  },
  async duplicate(id: string) {
    const b = await find(id);
    const { id: _id, createdAt: _c, updatedAt: _u, handle: _h, ...rest } = b;
    let name = `${b.name} (Copy)`;
    for (let i = 2; await prisma.brand.findUnique({ where: { name } }); i++) name = `${b.name} (Copy ${i})`;
    return this.create({ ...rest, name, status: "draft", featured: false });
  },
  async remove(id: string) {
    const b = await find(id);
    const used = await prisma.product.count({ where: { brandId: b.id, deletedAt: null } });
    if (used) throw ApiError.conflict("CONFLICT", `${used} product(s) use this brand. Archive the brand instead.`);
    await prisma.brand.delete({ where: { id: b.id } });
    return b;
  },
};
