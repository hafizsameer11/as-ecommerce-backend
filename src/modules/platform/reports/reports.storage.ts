/**
 * Report files hold finance and customer data, so they are NOT written under UPLOAD_DIR (which is served
 * publicly at /uploads). Same StorageDriver interface, rooted in a private folder that is only read by
 * the authenticated download endpoint: REPORTS_DIR, default `<UPLOAD_DIR>-private`.
 * Swap for a private S3 bucket together with the public driver when scaling out.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/config/env";
import type { StorageDriver } from "@/providers/storage/storage";

class PrivateDiskDriver implements StorageDriver {
  private root = path.resolve(process.env.REPORTS_DIR || `${env.UPLOAD_DIR.replace(/[\\/]+$/, "")}-private`);

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
  /** no public URL: files are streamed by GET /admin/reports/runs/:runId/download */
  url(key: string) {
    return `private://${key}`;
  }
}

export const reportStorage: StorageDriver = new PrivateDiskDriver();
