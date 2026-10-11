import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta } from "@/core/http/pagination";
import { events } from "@/core/events/bus";
import { mediaService, type UploadInput } from "@/modules/content/media/media.service";

const FIT_LABEL = { runs_small: "Runs small", true_to_size: "True to size", runs_large: "Runs large" } as const;
export type ReviewStatus = "pending" | "published" | "rejected" | "flagged";

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

function storeDto(r: Prisma.ReviewGetPayload<object>) {
  return {
    id: r.id, author: r.authorName, initials: initials(r.authorName), rating: r.rating, title: r.title, body: r.body,
    date: r.createdAt, verified: r.verified, helpful: r.helpfulCount, size: r.size, fit: r.fit ? FIT_LABEL[r.fit] : null,
    photos: (r.photos as string[] | null) ?? [], reply: r.replyBody ? { body: r.replyBody, author: r.replyAuthor, at: r.repliedAt } : null,
  };
}

async function findProduct(idOrHandle: string) {
  const p = await prisma.product.findFirst({ where: { OR: [{ id: idOrHandle }, { handle: idOrHandle }] }, select: { id: true, handle: true, name: true } });
  if (!p) throw ApiError.notFound("Product");
  return p;
}

/** keep Product.ratingAvg / ratingCount in sync with published reviews */
async function recompute(productId: string) {
  const agg = await prisma.review.aggregate({ where: { productId, status: "published" }, _avg: { rating: true }, _count: true });
  await prisma.product.update({ where: { id: productId }, data: { ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10, ratingCount: agg._count } });
}

export const reviewsService = {
  recompute,

  async listForProduct(idOrHandle: string, q: { page: number; pageSize: number; sort: "recent" | "helpful" | "highest" | "lowest"; rating?: number; withPhotos?: boolean }) {
    const p = await findProduct(idOrHandle);
    const where: Prisma.ReviewWhereInput = { productId: p.id, status: "published", rating: q.rating };
    const orderBy: Prisma.ReviewOrderByWithRelationInput =
      q.sort === "helpful" ? { helpfulCount: "desc" } : q.sort === "highest" ? { rating: "desc" } : q.sort === "lowest" ? { rating: "asc" } : { createdAt: "desc" };
    const [rows, total, dist, fits] = await Promise.all([
      prisma.review.findMany({ where, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ["rating"], where: { productId: p.id, status: "published" }, _count: true }),
      prisma.review.groupBy({ by: ["fit"], where: { productId: p.id, status: "published", fit: { not: null } }, _count: true }),
    ]);
    const count = dist.reduce((n, d) => n + d._count, 0);
    const sum = dist.reduce((n, d) => n + d.rating * d._count, 0);
    return {
      items: rows.map(storeDto),
      summary: {
        average: count ? Math.round((sum / count) * 10) / 10 : 0,
        count,
        distribution: [5, 4, 3, 2, 1].map((star) => ({ star, count: dist.find((d) => d.rating === star)?._count ?? 0 })),
        fit: Object.entries(FIT_LABEL).map(([k, label]) => ({ key: k, label, count: fits.find((f) => f.fit === k)?._count ?? 0 })),
      },
      meta: pageMeta(q, total),
    };
  },

  async create(customerId: string, idOrHandle: string, input: { rating: number; title: string; body: string; size?: string; fit?: keyof typeof FIT_LABEL }, photos: UploadInput[]) {
    const p = await findProduct(idOrHandle);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const dup = await prisma.review.findFirst({ where: { productId: p.id, customerId, status: { not: "rejected" } } });
    if (dup) throw ApiError.conflict("CONFLICT", "You've already reviewed this product.");
    // verified purchase = a paid order containing this product
    const bought = await prisma.orderItem.findFirst({ where: { productId: p.id, order: { customerId, paymentStatus: { in: ["paid", "partially_refunded"] } } } });
    const urls: string[] = [];
    for (const f of photos.slice(0, 4)) {
      const a = await mediaService.upload(f, "reviews", `customer:${customerId}`);
      urls.push((a.variants as Record<string, string> | null)?.md ?? a.url);
    }
    const r = await prisma.review.create({
      data: {
        productId: p.id, customerId, authorName: `${c.firstName} ${c.lastName.slice(0, 1)}${c.lastName ? "." : ""}`.trim(),
        rating: input.rating, title: input.title, body: input.body, size: input.size, fit: input.fit, verified: !!bought,
        photos: urls, status: "pending",
      },
    });
    return { ...storeDto(r), status: r.status, message: "Thanks! Your review will appear once it's approved." };
  },

  async vote(customerId: string, reviewId: string, kind: "helpful" | "report") {
    const r = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!r || r.status !== "published") throw ApiError.notFound("Review");
    try {
      await prisma.reviewVote.create({ data: { reviewId, customerId, kind } });
    } catch {
      return { counted: false };
    }
    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: kind === "helpful" ? { helpfulCount: { increment: 1 } } : { reportedCount: { increment: 1 } },
    });
    // 3 reports auto-flag the review for moderation
    if (kind === "report" && updated.reportedCount >= 3) {
      await prisma.review.update({ where: { id: reviewId }, data: { status: "flagged", flaggedReason: "Reported by customers" } });
      await recompute(r.productId);
    }
    return { counted: true, helpful: updated.helpfulCount };
  },

  // ── admin /reviews ──
  async adminList(q: { page: number; pageSize: number; status?: ReviewStatus; rating?: number; q?: string; product?: string }) {
    const where: Prisma.ReviewWhereInput = {
      status: q.status,
      rating: q.rating,
      product: q.product ? { OR: [{ id: q.product }, { handle: q.product }] } : undefined,
      OR: q.q ? [{ title: { contains: q.q } }, { body: { contains: q.q } }, { authorName: { contains: q.q } }, { product: { name: { contains: q.q } } }] : undefined,
    };
    const [rows, total, counts] = await Promise.all([
      prisma.review.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { product: { select: { handle: true, name: true, brand: { select: { name: true } }, images: { take: 1, orderBy: { position: "asc" } } } } },
      }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ["status"], _count: true }),
    ]);
    return {
      items: rows.map((r) => ({
        ...storeDto(r), status: r.status, flaggedReason: r.flaggedReason, reportedCount: r.reportedCount,
        productId: r.product.handle, productName: r.product.name, productBrand: r.product.brand.name, productImage: r.product.images[0]?.url ?? null,
      })),
      meta: { ...pageMeta(q, total), counts: Object.fromEntries(counts.map((c) => [c.status, c._count])) },
    };
  },

  async setStatus(ids: string[], status: ReviewStatus, reason?: string) {
    const rows = await prisma.review.findMany({ where: { id: { in: ids } }, select: { id: true, productId: true, status: true } });
    await prisma.review.updateMany({ where: { id: { in: ids } }, data: { status, flaggedReason: status === "flagged" ? reason ?? "Flagged by moderator" : null } });
    for (const pid of new Set(rows.map((r) => r.productId))) await recompute(pid);
    for (const r of rows) if (status === "published" && r.status !== "published") events.emit("review.published", { reviewId: r.id });
    return { updated: rows.length };
  },

  async reply(id: string, body: string, author: string) {
    const r = await prisma.review.update({ where: { id }, data: { replyBody: body, replyAuthor: author, repliedAt: new Date() } });
    return storeDto(r);
  },

  async remove(ids: string[]) {
    const rows = await prisma.review.findMany({ where: { id: { in: ids } }, select: { productId: true } });
    await prisma.review.deleteMany({ where: { id: { in: ids } } });
    for (const pid of new Set(rows.map((r) => r.productId))) await recompute(pid);
    return { deleted: rows.length };
  },
};
