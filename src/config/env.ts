import { z } from "zod";

/** exported for tests (cross-field rules: Paystack key, mock gateway in production) */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  APP_URL: z.string().url().default("http://localhost:4000"),
  /** customer website (links in emails: pay draft orders, recover carts, track orders) */
  WEB_URL: z.string().url().default("http://localhost:3000"),
  /** admin app (absolute links in staff alert e-mails) */
  ADMIN_URL: z.string().url().default("http://localhost:3001"),
  CORS_ORIGINS: z.string().default(""),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default(""),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),
  /** local = disk under UPLOAD_DIR (one server only) · s3 = any S3-compatible store (AWS S3, Cloudflare R2, MinIO) */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  UPLOAD_DIR: z.string().default("./uploads"),
  PUBLIC_UPLOAD_URL: z.string().default("http://localhost:4000/uploads"),
  /** public uploads (product images, media library) */
  S3_BUCKET: z.string().optional(),
  /** "auto" for R2 */
  S3_REGION: z.string().default("auto"),
  /** R2: https://<account>.r2.cloudflarestorage.com · MinIO: http://minio:9000 · empty for AWS */
  S3_ENDPOINT: z.string().url().optional(),
  /** empty = the AWS default credential chain (IAM role) */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** public base URL of S3_BUCKET (CDN / R2 custom domain), e.g. https://cdn.asloriginals.com */
  S3_PUBLIC_URL: z.string().url().optional(),
  /** private files (report exports): a bucket with NO public access. Empty = S3_BUCKET under `private/` (only safe if the bucket policy keeps that prefix private) */
  S3_PRIVATE_BUCKET: z.string().optional(),
  /** GET /metrics needs `Authorization: Bearer <token>` when set (always set it in production) */
  METRICS_TOKEN: z.string().optional(),
  /** worker: serve its own /metrics on this port (0 = off) */
  WORKER_METRICS_PORT: z.coerce.number().default(0),
  PAYMENT_PROVIDER: z.enum(["mock", "paystack"]).default("mock"),
  /** mock gateway webhook secret (Paystack signs webhooks with PAYSTACK_SECRET_KEY) */
  PAYMENT_WEBHOOK_SECRET: z.string().min(8).default("dev-webhook-secret"),
  /** shared secret carriers send in `X-Carrier-Secret` on POST /webhooks/carriers/:carrier (unset = carrier webhooks refused) */
  CARRIER_WEBHOOK_SECRET: z.string().min(16).optional(),
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_\w+$/, "must look like sk_test_… or sk_live_…").optional(),
  PAYSTACK_PUBLIC_KEY: z.string().regex(/^pk_(test|live)_\w+$/, "must look like pk_test_… or pk_live_…").optional(),
  /** where Paystack sends the customer after paying (default: the dashboard setting) */
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  /** production with the mock gateway (staging/demo only) */
  ALLOW_MOCK_PAYMENTS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  MAIL_FROM: z.string().default("ASL ORIGINALS <no-reply@asloriginals.com>"),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMS_PROVIDER: z.enum(["mock"]).default("mock"),
  PUSH_PROVIDER: z.enum(["mock", "expo"]).default("mock"),
  LOG_LEVEL: z.string().default("info"),
}).superRefine((e, ctx) => {
  if (e.STORAGE_DRIVER === "s3") {
    if (!e.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "required when STORAGE_DRIVER=s3" });
    if (!e.S3_PUBLIC_URL) ctx.addIssue({ code: "custom", path: ["S3_PUBLIC_URL"], message: "required when STORAGE_DRIVER=s3 (public URL of the bucket / CDN)" });
    if (!!e.S3_ACCESS_KEY_ID !== !!e.S3_SECRET_ACCESS_KEY)
      ctx.addIssue({ code: "custom", path: ["S3_SECRET_ACCESS_KEY"], message: "set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (or neither, for an IAM role)" });
  }
  if (e.PAYMENT_PROVIDER === "paystack" && !e.PAYSTACK_SECRET_KEY)
    ctx.addIssue({ code: "custom", path: ["PAYSTACK_SECRET_KEY"], message: "required when PAYMENT_PROVIDER=paystack" });
  if (e.PAYMENT_PROVIDER === "mock" && e.NODE_ENV === "production" && !e.ALLOW_MOCK_PAYMENTS)
    ctx.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "the mock gateway takes no real money: set PAYMENT_PROVIDER=paystack (or ALLOW_MOCK_PAYMENTS=true for a demo)" });
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
export const isTest = env.NODE_ENV === "test";
export const isProd = env.NODE_ENV === "production";
export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
