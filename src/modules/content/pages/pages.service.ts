import { randomBytes } from "node:crypto";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import type { Prisma, Page } from "@/generated/prisma/client";
import { logger } from "@/core/utils/logger";
import { mediaService } from "../media/media.service";
import {
  cleanHtml, cleanText, freeSlug, renderTokens, slugify, statusFields, tokenContext, unknownTokens, type TokenContext,
} from "../content.common";
import { pageAdmin, pagePath, pageStore } from "./pages.mapper";
import {
  blockSchema, type BlockAdd, type BlockMove, type BlockType, type PageBlock, type PageCreate, type PageListQuery, type PagePatch, type PageStatusBody,
} from "./pages.schemas";

const blockId = () => randomBytes(5).toString("hex");
const json = (v: unknown) => v as Prisma.InputJsonValue;

/* ── blocks ──────────────────────────────────────────────────────────── */

const TEXT_KEYS = new Set(["title", "eyebrow", "ctaLabel", "alt", "value", "icon", "variant"]);

/** strip markup from text fields, allow-list HTML in `body` fields (also inside items) */
function sanitizeFields<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string") out[k] = k === "body" ? cleanHtml(v) : TEXT_KEYS.has(k) ? cleanText(v) : v.trim();
    else if (k === "items" && Array.isArray(v)) out[k] = v.map((i) => (i && typeof i === "object" ? sanitizeFields(i as Record<string, unknown>) : i));
    else out[k] = v;
  }
  return out as T;
}

/** sanitize → validate per type → give every block an id */
function prepareBlock(raw: unknown, index = 0): PageBlock {
  const clean = raw && typeof raw === "object" ? sanitizeFields(raw as Record<string, unknown>) : raw;
  const r = blockSchema.safeParse(clean);
  if (!r.success)
    throw ApiError.badRequest("VALIDATION_FAILED", "Please check the block fields.", r.error.issues.map((i) => ({ path: `blocks.${index}.${i.path.join(".")}`, message: i.message })));
  return { ...r.data, id: r.data.id ?? blockId() } as PageBlock;
}
const prepareBlocks = (blocks: unknown[]) => {
  const out = blocks.map((b, i) => prepareBlock(b, i));
  const ids = new Set<string>();
  for (const b of out) {
    if (ids.has(b.id)) b.id = blockId();
    ids.add(b.id);
  }
  return out;
};

/** what "Add block" creates before the editor fills it in */
const BLOCK_DEFAULTS: Record<BlockType, Record<string, unknown>> = {
  hero: { title: "New section", body: "A short subheading that frames the page." },
  rich_text: { body: "<p>Write something…</p>" },
  image: { imageUrl: "/placeholder.jpg", alt: "" },
  gallery: { items: [{ imageUrl: "/placeholder.jpg" }] },
  cta: { title: "Ready to shop?", ctaLabel: "Shop now", ctaHref: "/shop" },
  faq: { items: [{ title: "Question", body: "<p>Answer</p>" }] },
  video: { videoUrl: "https://www.youtube.com/watch?v=", title: "" },
  columns: { items: [{ title: "Column", body: "<p>Text</p>" }] },
  quote: { body: "<p>Quote</p>" },
};

const blocksOf = (p: Page) => ((p.blocks as PageBlock[] | null) ?? []);

/** every uploaded file a page references → MediaUsage ("used in") */
function mediaUrls(p: { heroImage?: string | null; ogImage?: string | null; blocks: PageBlock[] }) {
  const urls: string[] = [p.heroImage ?? "", p.ogImage ?? ""];
  for (const b of p.blocks) {
    const r = b as Record<string, unknown>;
    if (typeof r.imageUrl === "string") urls.push(r.imageUrl);
    for (const i of (r.items as Record<string, unknown>[] | undefined) ?? []) if (typeof i.imageUrl === "string") urls.push(i.imageUrl);
    for (const m of String(r.body ?? "").matchAll(/src="([^"]+)"/g)) urls.push(m[1]);
  }
  return urls.filter(Boolean);
}
const syncMedia = (p: Page) => mediaService.syncUsage("page", p.id, mediaUrls({ heroImage: p.heroImage, ogImage: p.ogImage, blocks: blocksOf(p) }));

/** FAQ blocks that point at a FAQ category get the live, published questions */
async function expandFaqBlocks(blocks: PageBlock[]) {
  const slugs = [...new Set(blocks.flatMap((b) => (b.type === "faq" && b.faqCategory ? [b.faqCategory] : [])))];
  if (!slugs.length) return blocks;
  const cats = await prisma.faqCategory.findMany({
    where: { slug: { in: slugs } },
    include: { items: { where: { status: "published" }, orderBy: { position: "asc" } } },
  });
  const by = new Map(cats.map((c) => [c.slug, c]));
  return blocks.map((b) => {
    if (b.type !== "faq" || !b.faqCategory) return b;
    const c = by.get(b.faqCategory);
    return { ...b, items: [...(b.items ?? []), ...(c?.items ?? []).map((i) => ({ title: i.question, body: i.answer, value: i.id }))] };
  });
}

async function loadPage(id: string) {
  const p = await prisma.page.findUnique({ where: { id } });
  if (!p) throw ApiError.notFound("Page");
  return p;
}

async function assertSlugFree(slug: string, exceptId?: string) {
  const other = await prisma.page.findUnique({ where: { slug }, select: { id: true } });
  if (other && other.id !== exceptId) throw ApiError.conflict("CONFLICT", `Another page already uses /${slug}.`, [{ path: "slug", message: "Already in use" }]);
}

async function saveBlocks(p: Page, blocks: PageBlock[]) {
  const after = await prisma.page.update({ where: { id: p.id }, data: { blocks: json(blocks) } });
  await syncMedia(after);
  return pageAdmin(after);
}

async function render(p: Page, ctx?: TokenContext) {
  const c = ctx ?? (await tokenContext());
  return pageStore(p, await expandFaqBlocks(blocksOf(p)), c);
}

export const pagesService = {
  /* ── store ── */

  async getPublished(slug: string, customerId?: string) {
    const p = await prisma.page.findUnique({ where: { slug } });
    if (!p || p.status !== "published") throw ApiError.notFound("Page");
    if (p.visibility === "members" && !customerId) throw ApiError.unauthenticated("Please sign in to view this page.");
    prisma.page.update({ where: { id: p.id }, data: { views30d: { increment: 1 } } }).catch((err) => logger.warn({ err }, "page view count failed"));
    return render(p);
  },

  /** header + footer links (published, not unlisted). Footer is grouped: legal pages vs the rest. */
  async navigation() {
    const pages = await prisma.page.findMany({
      where: { status: "published", visibility: { not: "unlisted" }, OR: [{ showInHeader: true }, { showInFooter: true }] },
      orderBy: [{ createdAt: "asc" }, { title: "asc" }],
    });
    const ctx = await tokenContext();
    const link = (p: Page) => ({ title: renderTokens(p.title, ctx, "text"), href: pagePath(p.slug), slug: p.slug, template: p.template, membersOnly: p.visibility === "members" });
    const footer = pages.filter((p) => p.showInFooter);
    return {
      header: pages.filter((p) => p.showInHeader).map(link),
      footer: footer.map(link),
      footerGroups: [
        { title: "Customer care", links: footer.filter((p) => p.template !== "legal").map(link) },
        { title: "Legal", links: footer.filter((p) => p.template === "legal").map(link) },
      ].filter((g) => g.links.length),
    };
  },

  /* ── admin ── */

  async list(q: PageListQuery) {
    const where: Prisma.PageWhereInput = {
      ...(q.template ? { template: q.template } : {}),
      ...(q.visibility ? { visibility: q.visibility } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q } }, { slug: { contains: q.q.replace(/^\//, "") } }] } : {}),
    };
    const [rows, total, counts, views] = await Promise.all([
      prisma.page.findMany({ where: { ...where, ...(q.status !== "all" ? { status: q.status } : {}) }, orderBy: { updatedAt: "desc" }, ...paging(q) }),
      prisma.page.count({ where: { ...where, ...(q.status !== "all" ? { status: q.status } : {}) } }),
      prisma.page.groupBy({ by: ["status"], where, _count: true }),
      prisma.page.aggregate({ where, _sum: { views30d: true } }),
    ]);
    const n = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
    const tabs = { all: counts.reduce((a, c) => a + c._count, 0), published: n("published"), draft: n("draft"), scheduled: n("scheduled"), archived: n("archived") };
    return withMeta(rows.map(pageAdmin), { ...pageMeta(q, total), tabs, kpis: { published: tabs.published, scheduled: tabs.scheduled, views30d: views._sum.views30d ?? 0 } });
  },

  async get(id: string) {
    return pageAdmin(await loadPage(id));
  },

  async create(b: PageCreate, by: string) {
    const slug = b.slug ?? slugify(b.title);
    await assertSlugFree(slug);
    const blocks = prepareBlocks(b.blocks ?? [{ type: "hero", title: b.title }]);
    const p = await prisma.page.create({
      data: {
        title: cleanText(b.title), slug, template: b.template, visibility: b.visibility, status: b.status,
        subtitle: b.subtitle ?? null, author: b.author ?? by, seoTitle: b.seoTitle ?? null, seoDescription: b.seoDescription ?? null,
        ogImage: b.ogImage ?? null, heroImage: b.heroImage ?? null, showInHeader: b.showInHeader, showInFooter: b.showInFooter,
        tags: json(b.tags), blocks: json(blocks), publishedAt: b.status === "published" ? new Date() : null,
      },
    });
    await syncMedia(p);
    return pageAdmin(p);
  },

  async update(id: string, patch: PagePatch) {
    const before = await loadPage(id);
    if (patch.slug && patch.slug !== before.slug) await assertSlugFree(patch.slug, id);
    const { blocks, tags, title, ...rest } = patch;
    const after = await prisma.page.update({
      where: { id },
      data: {
        ...rest,
        ...(title !== undefined ? { title: cleanText(title) } : {}),
        ...(tags !== undefined ? { tags: json(tags) } : {}),
        ...(blocks !== undefined ? { blocks: json(prepareBlocks(blocks)) } : {}),
      },
    });
    await syncMedia(after);
    return { before: pageAdmin(before), after: pageAdmin(after) };
  },

  async remove(id: string) {
    const p = await loadPage(id);
    await prisma.page.delete({ where: { id } });
    await mediaService.syncUsage("page", id, []);
    return { id, slug: p.slug, deleted: true };
  },

  async duplicate(id: string) {
    const src = await loadPage(id);
    const slug = await freeSlug(`${src.slug}-copy`, async (s) => !!(await prisma.page.findUnique({ where: { slug: s }, select: { id: true } })));
    const blocks = blocksOf(src).map((b) => ({ ...b, id: blockId() }));
    const p = await prisma.page.create({
      data: {
        title: `${src.title} (copy)`, slug, template: src.template, visibility: src.visibility, status: "draft",
        subtitle: src.subtitle, author: src.author, seoTitle: src.seoTitle, seoDescription: src.seoDescription, ogImage: src.ogImage,
        heroImage: src.heroImage, showInHeader: src.showInHeader, showInFooter: src.showInFooter, tags: json(src.tags ?? []), blocks: json(blocks),
      },
    });
    await syncMedia(p);
    return pageAdmin(p);
  },

  async setStatus(id: string, b: PageStatusBody) {
    const before = await loadPage(id);
    const after = await prisma.page.update({ where: { id }, data: statusFields(b.status, b.scheduledFor, before) });
    return { before: pageAdmin(before), after: pageAdmin(after) };
  },

  async addBlock(id: string, b: BlockAdd) {
    const p = await loadPage(id);
    const { position, ...fields } = b;
    const block = prepareBlock({ ...BLOCK_DEFAULTS[b.type], ...fields, id: undefined });
    const blocks = [...blocksOf(p)];
    blocks.splice(position ?? blocks.length, 0, block);
    return saveBlocks(p, blocks);
  },

  async updateBlock(id: string, blockIdParam: string, patch: Record<string, unknown>) {
    const p = await loadPage(id);
    const blocks = [...blocksOf(p)];
    const i = blocks.findIndex((b) => b.id === blockIdParam);
    if (i < 0) throw ApiError.notFound("Block");
    if (patch.type && patch.type !== blocks[i].type) throw ApiError.badRequest("VALIDATION_FAILED", "A block's type can't be changed. Add a new block instead.");
    // null clears an optional field
    const merged: Record<string, unknown> = { ...blocks[i], ...patch, id: blocks[i].id, type: blocks[i].type };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    blocks[i] = prepareBlock(merged, i);
    return saveBlocks(p, blocks);
  },

  async removeBlock(id: string, blockIdParam: string) {
    const p = await loadPage(id);
    const blocks = blocksOf(p);
    if (!blocks.some((b) => b.id === blockIdParam)) throw ApiError.notFound("Block");
    return saveBlocks(p, blocks.filter((b) => b.id !== blockIdParam));
  },

  async moveBlock(id: string, blockIdParam: string, m: BlockMove) {
    const p = await loadPage(id);
    const blocks = [...blocksOf(p)];
    const i = blocks.findIndex((b) => b.id === blockIdParam);
    if (i < 0) throw ApiError.notFound("Block");
    const j = "dir" in m ? i + m.dir : Math.min(m.to, blocks.length - 1);
    if (j < 0 || j >= blocks.length || j === i) return pageAdmin(p);
    const [b] = blocks.splice(i, 1);
    blocks.splice(j, 0, b);
    return saveBlocks(p, blocks);
  },

  /** exactly what the storefront would show (any status), plus tokens the renderer doesn't know */
  async preview(id: string) {
    const p = await loadPage(id);
    const ctx = await tokenContext();
    const raw = JSON.stringify([p.title, p.subtitle, p.blocks]);
    return { ...(await render(p, ctx)), status: p.status, scheduledFor: p.scheduledFor, warnings: [...new Set(unknownTokens(raw, ctx))].map((t) => `Unknown value {{${t}}}`) };
  },

  /** content.publish-scheduled */
  async publishDue(now = new Date()) {
    const due = await prisma.page.findMany({ where: { status: "scheduled", scheduledFor: { lte: now } }, select: { id: true, scheduledFor: true } });
    for (const p of due)
      await prisma.page.updateMany({ where: { id: p.id, status: "scheduled" }, data: { status: "published", publishedAt: p.scheduledFor ?? now, scheduledFor: null } });
    return due.length;
  },
};
