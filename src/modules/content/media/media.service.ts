import sharp, { type Sharp, type Metadata } from "sharp";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import type { MediaAsset, MediaUsage, Prisma } from "@/generated/prisma/client";
import { newStorageKey, storage } from "@/providers/storage/storage";

const SIZES = { sm: 320, md: 800, lg: 1600 } as const;

export type UploadInput = { buffer: Buffer; originalname: string; mimetype: string; size: number };

/**
 * Stores an upload (images are converted to WebP with sm/md/lg variants)
 * and records it in the media library so admin → /media shows everything.
 */
async function upload(file: UploadInput, folder: string, uploadedBy: string, altText = "") {
  const isImage = file.mimetype.startsWith("image/");
  if (!isImage) {
    const ext = file.originalname.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
    const key = newStorageKey(folder, ext);
    const { url } = await storage.put(key, file.buffer, file.mimetype);
    return prisma.mediaAsset.create({
      data: {
        name: file.originalname.slice(0, 190), key, url, mimeType: file.mimetype,
        type: file.mimetype.startsWith("video/") ? "video" : "document", folder, sizeBytes: file.size, uploadedBy, altText,
      },
    });
  }
  let img: Sharp;
  let meta: Metadata;
  try {
    img = sharp(file.buffer, { failOn: "error" }).rotate();
    meta = await img.metadata();
  } catch {
    throw ApiError.badRequest("UNSUPPORTED_FILE", "This image could not be read.");
  }
  const key = newStorageKey(folder, "webp");
  const main = await img.clone().resize({ width: 2400, withoutEnlargement: true }).webp({ quality: 86 }).toBuffer({ resolveWithObject: true });
  const { url } = await storage.put(key, main.data, "image/webp");
  const variants: Record<string, string> = {};
  for (const [name, width] of Object.entries(SIZES)) {
    if (meta.width && meta.width <= width) continue;
    const vKey = key.replace(/\.webp$/, `-${name}.webp`);
    const buf = await img.clone().resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    variants[name] = (await storage.put(vKey, buf, "image/webp")).url;
  }
  return prisma.mediaAsset.create({
    data: {
      name: file.originalname.slice(0, 190), key, url, variants, mimeType: "image/webp", type: "image", folder,
      sizeBytes: main.info.size, width: main.info.width, height: main.info.height, uploadedBy, altText,
    },
  });
}

async function remove(id: string, force = false) {
  const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id }, include: { usages: true } });
  if (asset.usages.length && !force)
    throw ApiError.conflict("CONFLICT", `This file is used in ${asset.usages.length} place(s). Remove it there first or delete with force.`);
  await storage.delete(asset.key).catch(() => undefined);
  for (const v of Object.values((asset.variants as Record<string, string>) ?? {})) {
    const k = v.split("/uploads/")[1];
    if (k) await storage.delete(k).catch(() => undefined);
  }
  await prisma.mediaAsset.delete({ where: { id } });
}

/** Keep MediaAsset.usages in sync when an entity references uploaded files by URL. */
async function syncUsage(entityType: string, entityId: string, urls: (string | null | undefined)[]) {
  const list = urls.filter(Boolean) as string[];
  const assets = list.length ? await prisma.mediaAsset.findMany({ where: { url: { in: list } }, select: { id: true } }) : [];
  await prisma.$transaction([
    prisma.mediaUsage.deleteMany({ where: { entityType, entityId } }),
    prisma.mediaUsage.createMany({ data: assets.map((a) => ({ mediaId: a.id, entityType, entityId })), skipDuplicates: true }),
  ]);
}

/* ── admin media library (asl-admin /media) ─────────────────────────── */

export type MediaListQuery = { page: number; pageSize: number; q?: string; sort?: string; folder?: string; type?: "image" | "video" | "document"; starred?: boolean };
export type MediaPatch = { name?: string; altText?: string; tags?: string[]; folder?: string };

const mediaOut = (a: MediaAsset & { usages?: MediaUsage[] }) => ({
  id: a.id,
  name: a.name,
  url: a.url,
  variants: (a.variants as Record<string, string> | null) ?? {},
  mimeType: a.mimeType,
  type: a.type,
  folder: a.folder,
  sizeBytes: a.sizeBytes,
  sizeKB: Math.round(a.sizeBytes / 1024),
  width: a.width,
  height: a.height,
  altText: a.altText,
  tags: (a.tags as string[] | null) ?? [],
  starred: a.starred,
  uploadedBy: a.uploadedBy,
  uploadedAt: a.createdAt,
  usedIn: (a.usages ?? []).map((u) => ({ entityType: u.entityType, entityId: u.entityId })),
});

async function list(q: MediaListQuery) {
  const base: Prisma.MediaAssetWhereInput = {
    ...(q.type ? { type: q.type } : {}),
    ...(q.starred !== undefined ? { starred: q.starred } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q } }, { altText: { contains: q.q } }] } : {}),
  };
  const where = { ...base, ...(q.folder ? { folder: q.folder } : {}) };
  const sort = q.sort === "name" ? { name: "asc" as const } : q.sort === "size" ? { sizeBytes: "desc" as const } : { createdAt: "desc" as const };
  const [rows, total, folders, size] = await Promise.all([
    prisma.mediaAsset.findMany({ where, include: { usages: true }, orderBy: sort, ...paging(q) }),
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.groupBy({ by: ["folder"], where: base, _count: true }),
    prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true }, _count: true }),
  ]);
  return withMeta(rows.map(mediaOut), {
    ...pageMeta(q, total),
    folders: Object.fromEntries(folders.map((f) => [f.folder, f._count])),
    kpis: { assets: size._count, totalBytes: size._sum.sizeBytes ?? 0 },
  });
}

async function get(id: string) {
  const a = await prisma.mediaAsset.findUnique({ where: { id }, include: { usages: true } });
  if (!a) throw ApiError.notFound("File");
  return mediaOut(a);
}

async function uploadMany(files: UploadInput[], folder: string, uploadedBy: string, altText = "", tags: string[] = []) {
  if (!files.length) throw ApiError.badRequest("VALIDATION_FAILED", "Choose at least one file.", [{ path: "files", message: "Required" }]);
  const out = [];
  for (const f of files) {
    const a = await upload(f, folder, uploadedBy, altText);
    out.push(tags.length ? await prisma.mediaAsset.update({ where: { id: a.id }, data: { tags } }) : a);
  }
  return out.map((a) => mediaOut(a));
}

async function update(id: string, patch: MediaPatch) {
  const before = await get(id);
  const a = await prisma.mediaAsset.update({ where: { id }, data: patch, include: { usages: true } });
  return { before, after: mediaOut(a) };
}

async function toggleStar(id: string) {
  const a = await get(id);
  return mediaOut(await prisma.mediaAsset.update({ where: { id }, data: { starred: !a.starred }, include: { usages: true } }));
}

async function move(ids: string[], folder: string) {
  const r = await prisma.mediaAsset.updateMany({ where: { id: { in: ids } }, data: { folder } });
  return { moved: r.count, folder };
}

/** all-or-nothing: refused while any file is in use, unless force */
async function bulkRemove(ids: string[], force = false) {
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: ids } }, include: { usages: true } });
  const used = assets.filter((a) => a.usages.length);
  if (used.length && !force)
    throw ApiError.conflict("CONFLICT", `${used.length} file(s) are in use. Remove them there first or delete with force.`, used.map((a) => ({ id: a.id, name: a.name, usedIn: a.usages.length })));
  for (const a of assets) await remove(a.id, true);
  return { deleted: assets.length, notFound: ids.filter((id) => !assets.some((a) => a.id === id)) };
}

export const mediaService = { upload, remove, syncUsage, list, get, uploadMany, update, toggleStar, move, bulkRemove };
