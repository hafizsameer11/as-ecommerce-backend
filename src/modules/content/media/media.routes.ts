import { ModuleRouter, idParam } from "@/core/http/router";
import { mediaController as c } from "./media.controller";
import { bulkDeleteBody, deleteQuery, mediaListQuery, mediaPatch, moveBody, uploadBody } from "./media.schemas";

const audit = (action: string) => ({ category: "content", action, entity: "media" });
const files = { field: "files", maxCount: 20, maxMB: 25, accept: /^(image\/(jpeg|png|webp|gif|heic|heif|avif|svg\+xml)|video\/(mp4|webm|quicktime)|application\/pdf)$/ };

/** asl-admin /media — images become WebP + sm/md/lg; "used in" comes from MediaUsage */
export const mediaAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/media", tag: "Media", defaultAuth: "admin", defaultPermission: "content.publish" })
  .get("/", { summary: "Library (folder, type, starred, q) + per-folder counts", query: mediaListQuery }, c.list)
  .post("/", { summary: "Upload (multipart `files`, up to 20; folder, altText, tags)", upload: files, body: uploadBody, status: 201, audit: audit("media.uploaded") }, c.upload)
  .post("/move", { summary: "Move files to a folder", body: moveBody, audit: audit("media.moved") }, c.move)
  .post("/bulk-delete", { summary: "Delete several (refused if any is used, unless force)", body: bulkDeleteBody, audit: audit("media.bulk_deleted") }, c.bulkRemove)
  .get("/:id", { summary: "File (+ where it's used)", params: idParam }, c.get)
  .patch("/:id", { summary: "Rename / alt text / tags / folder", params: idParam, body: mediaPatch, audit: audit("media.updated") }, c.update)
  .post("/:id/star", { summary: "Star / unstar", params: idParam }, c.star)
  .delete("/:id", { summary: "Delete (refused while used, unless ?force=true)", params: idParam, query: deleteQuery, audit: audit("media.deleted") }, c.remove);
