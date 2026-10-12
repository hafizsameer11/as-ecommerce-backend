import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** admin folders: products | hero | campaigns | concierge | brand | uncategorized (system ones: reviews, avatars, concierge-chat) */
export const folder = z.string().trim().toLowerCase().min(1).max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and - only");
const tags = z.array(z.string().trim().min(1).max(40)).max(30);

export const mediaListQuery = pageQuery.extend({
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
  folder: folder.optional(),
  type: z.enum(["image", "video", "document"]).optional(),
  starred: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

/** multipart fields next to `files` (tags: comma separated or repeated) */
export const uploadBody = z.object({
  folder: folder.default("uncategorized"),
  altText: z.string().max(300).default(""),
  tags: z.union([z.string(), z.array(z.string())]).optional()
    .transform((t) => (Array.isArray(t) ? t : (t ?? "").split(",")).map((s) => s.trim()).filter(Boolean).slice(0, 30)),
});

export const mediaPatch = z.object({
  name: z.string().trim().min(1).max(190),
  altText: z.string().max(300),
  tags,
  folder,
}).partial();
export const moveBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), folder });
export const bulkDeleteBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), force: z.boolean().default(false) });
export const deleteQuery = z.object({ force: z.enum(["true", "false"]).transform((v) => v === "true").default(false) });

export type MediaListQueryIn = z.infer<typeof mediaListQuery>;
export type UploadBody = z.infer<typeof uploadBody>;
export type MediaPatchBody = z.infer<typeof mediaPatch>;
