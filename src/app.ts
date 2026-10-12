import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import crypto from "node:crypto";
import path from "node:path";
import swaggerUi from "swagger-ui-express";
import "@/core/http/openapi"; // zod openapi extension first
import { corsOrigins, env, isProd } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { errorHandler, notFoundHandler } from "@/core/middleware/error-handler";
import { ApiError } from "@/core/http/errors";
import { jsonReplacer } from "@/core/http/response";
import { buildOpenApiDocument } from "@/core/http/openapi";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { moduleRouters, registerListeners } from "@/modules";
import { httpMetrics, opsRouter } from "@/core/http/ops";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.set("json replacer", jsonReplacer);

  app.use(httpMetrics);
  app.use((req, res, next) => {
    req.id = (req.header("X-Request-Id") ?? crypto.randomUUID()).slice(0, 64);
    res.setHeader("X-Request-Id", req.id);
    const anon = req.header("X-Anon-Id");
    if (anon && /^[\w-]{8,64}$/.test(anon)) req.anonId = anon;
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id,
      autoLogging: { ignore: (req) => ["/health", "/ready", "/metrics"].includes(req.url!) || req.url!.startsWith("/uploads") },
      // one short line per request instead of full header dumps
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ status: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || !isProd || corsOrigins.includes(origin)),
      credentials: true,
      exposedHeaders: ["X-Request-Id", "Idempotent-Replay"],
    }),
  );
  app.use(cookieParser());
  // keep the raw body for webhook signature checks
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
  app.use(express.urlencoded({ extended: false }));

  app.use("/uploads", express.static(path.resolve(env.UPLOAD_DIR), { maxAge: "30d", immutable: true }));

  // GET /health (liveness), /ready (DB, Redis, storage), /metrics (Prometheus)
  app.use(opsRouter());

  // maintenance mode blocks the storefront, never the admin
  app.use("/api/v1/store", async (req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith("/settings")) return next();
    const m = await settingsService.get("maintenance");
    if (m.enabled) return next(new ApiError(503, "MAINTENANCE_MODE", m.message));
    next();
  });

  for (const r of moduleRouters) app.use(r.mountPath, r.router);

  const doc = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => res.json(doc));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(doc, { customSiteTitle: "ASL ORIGINALS API" }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  void registerListeners();
  return app;
}
