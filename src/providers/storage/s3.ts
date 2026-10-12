/**
 * S3-compatible storage (AWS S3, Cloudflare R2, MinIO …) — needed as soon as more than one API server runs,
 * because local disk is per machine. Public files are served by the bucket's public URL / CDN (S3_PUBLIC_URL);
 * private files (report exports) live in a bucket without public access and are only read by the API.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageDriver } from "./storage";

/** the part of S3Client the driver uses (tests pass a fake) */
export type S3Like = { send(command: unknown): Promise<any> };

export type S3DriverOptions = {
  bucket: string;
  /** key prefix inside the bucket, e.g. "private/" */
  prefix?: string;
  /** public base URL; omitted = private driver (url() returns private://key) */
  publicUrl?: string;
};

export type S3ClientConfig = { region: string; endpoint?: string; accessKeyId?: string; secretAccessKey?: string };

export function createS3Client(c: S3ClientConfig): S3Client {
  return new S3Client({
    region: c.region || "auto",
    // R2 / MinIO: custom endpoint + path-style URLs (bucket in the path, not the host)
    ...(c.endpoint ? { endpoint: c.endpoint, forcePathStyle: true } : {}),
    ...(c.accessKeyId && c.secretAccessKey ? { credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } } : {}),
  });
}

export class S3Driver implements StorageDriver {
  private prefix: string;
  constructor(private client: S3Like, private o: S3DriverOptions) {
    this.prefix = o.prefix ? o.prefix.replace(/^\/+/, "").replace(/\/?$/, "/") : "";
  }

  private objectKey(key: string) {
    if (!key || key.startsWith("/") || key.split("/").some((p) => p === ".." || p === ".") || key.includes("\\")) throw new Error("Invalid storage key");
    return this.prefix + key;
  }

  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.o.bucket, Key: this.objectKey(key), Body: data, ContentType: contentType,
        // keys are random and never overwritten → cache forever (public); private files are never cached
        CacheControl: this.o.publicUrl ? "public, max-age=31536000, immutable" : "private, no-store",
      }),
    );
    return { key, url: this.url(key) };
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: this.objectKey(key) }));
  }

  async read(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.objectKey(key) }));
    if (!out?.Body) throw new Error("Empty object");
    return Buffer.from(await out.Body.transformToByteArray());
  }

  url(key: string) {
    return this.o.publicUrl ? `${this.o.publicUrl.replace(/\/$/, "")}/${key}` : `private://${key}`;
  }

  /** /ready: the bucket exists and the credentials can reach it */
  async healthcheck() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.o.bucket }));
  }
}
