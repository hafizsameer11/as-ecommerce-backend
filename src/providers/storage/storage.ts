import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/config/env";

export interface StorageDriver {
  put(key: string, data: Buffer, contentType: string): Promise<{ key: string; url: string }>;
  delete(key: string): Promise<void>;
  url(key: string): string;
  read(key: string): Promise<Buffer>;
}

/**
 * Local disk under UPLOAD_DIR, served at /uploads. Use a Docker volume in production.
 * Only works on ONE server — implement an S3 driver (same interface) before scaling out.
 */
class LocalDiskDriver implements StorageDriver {
  private root = path.resolve(env.UPLOAD_DIR);

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
    return `${env.PUBLIC_UPLOAD_URL.replace(/\/$/, "")}/${key}`;
  }
}

export const storage: StorageDriver = new LocalDiskDriver();

/** 2026/10/k3j2h4….webp */
export function newStorageKey(folder: string, ext: string) {
  const d = new Date();
  const id = crypto.randomBytes(12).toString("base64url");
  return `${folder}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}.${ext}`;
}
