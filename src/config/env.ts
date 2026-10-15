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
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default(""),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  UPLOAD_DIR: z.string().default("./uploads"),
  PUBLIC_UPLOAD_URL: z.string().default("http://localhost:4000/uploads"),
  PAYMENT_PROVIDER: z.enum(["mock", "paystack"]).default("mock"),
  /** mock gateway webhook secret (Paystack signs webhooks with PAYSTACK_SECRET_KEY) */
  PAYMENT_WEBHOOK_SECRET: z.string().min(8).default("dev-webhook-secret"),
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
  /**
   * When true on boot, upsert seed admin password from SEED_ADMIN_* .
   * Default true so a fresh deploy can restore known credentials; set SEED_ADMIN_RESET=false in host env after first login.
   */
  SEED_ADMIN_RESET: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@asloriginals.com"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  /**
   * Secret for POST /admin/auth/bootstrap.
   * Temporary default so production can be unblocked after deploy; override or clear in host env after use.
   */
  ADMIN_BOOTSTRAP_SECRET: z.string().min(16).default("asl-one-time-bootstrap-2026"),
}).superRefine((e, ctx) => {
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
