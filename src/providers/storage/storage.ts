import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/config/env";
import { createS3Client, S3Driver } from "./s3";

export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<{ key: string; url: string }>;
  delete(key: string): Promise<void>;
  url(key: string): string;
  read(key: string): Promise<Buffer>;
  /** /ready: throws when the store can't be written / reached */
  healthcheck?(): Promise<void>;
}

/**
 * Local disk under a root folder. Public uploads: UPLOAD_DIR, served at /uploads (use a Docker volume).
 * Only works on ONE server — set STORAGE_DRIVER=s3 before scaling out.
 */
export class LocalDiskDriver implements StorageDriver {
  private root: string;
  /** publicUrl omitted = private folder (url() returns private://key, files only read by the API) */
  constructor(root: string, private publicUrl?: string) {
    this.root = path.resolve(root);
  }

  private safe(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.safe(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return { key, url: this.url(key) };
  }
  async delete(key: string) {
    await fs.rm(this.safe(key), { force: true });
  }
  async read(key: string) {
    return fs.readFile(this.safe(key));
  }
  url(key: string) {
    return this.publicUrl ? `${this.publicUrl.replace(/\/$/, "")}/${key}` : `private://${key}`;
  }
  async healthcheck() {
    await fs.mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.ready-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
  }
}

const s3Client = () => createS3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY });

/** public uploads (product images, media library) */
export const storage: StorageDriver =
  env.STORAGE_DRIVER === "s3" ? new S3Driver(s3Client(), { bucket: env.S3_BUCKET!, publicUrl: env.S3_PUBLIC_URL }) : new LocalDiskDriver(env.UPLOAD_DIR, env.PUBLIC_UPLOAD_URL);

/**
 * Private files (report exports with finance / customer data): never under a public URL, only streamed by the API.
 * s3: S3_PRIVATE_BUCKET (no public access), else S3_BUCKET under `private/` · local: REPORTS_DIR, default `<UPLOAD_DIR>-private`.
 */
export function createPrivateStorage(): StorageDriver {
  if (env.STORAGE_DRIVER === "s3")
    return env.S3_PRIVATE_BUCKET
      ? new S3Driver(s3Client(), { bucket: env.S3_PRIVATE_BUCKET })
      : new S3Driver(s3Client(), { bucket: env.S3_BUCKET!, prefix: "private/" });
  return new LocalDiskDriver(process.env.REPORTS_DIR || `${env.UPLOAD_DIR.replace(/[\\/]+$/, "")}-private`);
}

/** 2026/10/k3j2h4….webp */
export function newStorageKey(folder: string, ext: string) {
  const d = new Date();
  const id = crypto.randomBytes(12).toString("base64url");
  return `${folder}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
}
