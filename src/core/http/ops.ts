/**
 * Operations endpoints (outside /api/v1, no auth middleware):
 * - GET /health — liveness: the process answers. No DB call, so a slow database never gets the container restarted.
 * - GET /ready  — readiness: DB, Redis (when configured) and storage are usable → 200, else 503 with the failing checks.
 * - GET /metrics — Prometheus text format; `Authorization: Bearer <METRICS_TOKEN>` when METRICS_TOKEN is set.
 * Plus the request-duration middleware that feeds asl_http_request_duration_seconds.
 */
import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { Gauge } from "prom-client";
import { env, isProd } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { prisma } from "@/core/db/prisma";
import { getRedis } from "@/core/db/redis";
import { httpDuration, registry } from "@/core/metrics/metrics";
import { queueCounts } from "@/core/queue/queue";
import { storage, type StorageDriver } from "@/providers/storage/storage";
import { reportStorage } from "@/modules/platform/reports/reports.storage";

/** BullMQ queue depth, read from Redis at scrape time (shared by all processes) */
new Gauge({
  name: "asl_queue_jobs",
  help: "Jobs in the BullMQ queue by state (Redis only)",
  labelNames: ["state"] as const,
  registers: [registry],
  async collect() {
    const counts = await queueCounts().catch(() => null);
    this.reset();
    for (const [state, n] of Object.entries(counts ?? {})) this.set({ state }, n);
  },
});

/** route template, never the raw URL (ids would explode the label cardinality) */
function routeOf(req: Request, res: Response, status: number) {
  if (typeof res.locals.routeTemplate === "string") return res.locals.routeTemplate;
  if (req.route?.path) return `${req.baseUrl}${typeof req.route.path === "string" ? req.route.path : String(req.route.path)}`;
  if (req.path.startsWith("/uploads")) return "/uploads";
  if (req.path.startsWith("/docs")) return "/docs";
  return status === 404 ? "unmatched" : "other";
}

export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on("finish", () => end({ method: req.method, route: routeOf(req, res, res.statusCode), status: String(res.statusCode) }));
  next();
}

async function timed(name: string, fn: () => Promise<unknown>, timeoutMs = 3000) {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)))]);
    return { name, ok: true, ms: Date.now() - started };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, error: (err as Error)?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const storageCheck = (s: StorageDriver) => async () => {
  if (s.healthcheck) await s.healthcheck();
};

let shuttingDown = false;
/** server.ts on SIGTERM: report not-ready so the load balancer drains this instance */
export function markShuttingDown() {
  shuttingDown = true;
}

export async function readiness() {
  if (shuttingDown) return { ok: false, checks: [{ name: "shutdown", ok: false, ms: 0, error: "shutting down" }] };
  const redis = getRedis();
  const checks = await Promise.all([
    timed("database", () => prisma.$queryRaw`SELECT 1`),
    ...(redis ? [timed("redis", () => redis.ping())] : []),
    timed("storage", storageCheck(storage)),
    timed("privateStorage", storageCheck(reportStorage)),
  ]);
  return { ok: checks.every((c) => c.ok), checks };
}

function tokenOk(header: string | undefined) {
  if (!env.METRICS_TOKEN) return true;
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(env.METRICS_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** shared by the API route and the worker's tiny metrics server */
export async function renderMetrics(authorization: string | undefined) {
  if (!tokenOk(authorization)) return { status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "Metrics token required" } }) };
  return { status: 200, contentType: registry.contentType, body: await registry.metrics() };
}

export async function metricsHandler(req: Request, res: Response) {
  const out = await renderMetrics(req.header("authorization"));
  if (out.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
  res.status(out.status).setHeader("Content-Type", out.contentType);
  res.setHeader("Cache-Control", "no-store");
  res.send(out.body);
}

export function opsRouter() {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok", uptime: Math.round(process.uptime()), time: new Date().toISOString() });
  });
  r.get("/ready", async (_req, res) => {
    const out = await readiness();
    if (!out.ok) logger.warn({ checks: out.checks.filter((c) => !c.ok) }, "not ready");
    res.setHeader("Cache-Control", "no-store");
    // error texts can name hosts / buckets: logged, not shown publicly in production
    const checks = isProd ? out.checks.map(({ name, ok, ms }) => ({ name, ok, ms })) : out.checks;
    res.status(out.ok ? 200 : 503).json({ status: out.ok ? "ready" : "not_ready", checks });
  });
  r.get("/metrics", metricsHandler);
  return r;
}
