import sharp, { type Sharp, type Metadata } from "sharp";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
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

export const mediaService = { upload, remove, syncUsage };
