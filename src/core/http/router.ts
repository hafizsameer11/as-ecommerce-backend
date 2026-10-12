/**
 * Declarative routes: one call wires auth → permission → upload → validation →
 * idempotency → audit → controller, and documents the endpoint in OpenAPI.
 *
 *   r.post("/:id/refund", { summary: "Refund order", auth: "admin", permission: "orders.refund",
 *     params: idParam, body: refundSchema, audit: { category: "orders", action: "order.refunded" } },
 *     ordersController.refund);
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { z, type ZodType } from "zod";
import { registry } from "./openapi";
import { ok } from "./response";
import { ApiError } from "./errors";
import { optionalCustomer, requireAdmin, requireCustomer, requirePermission } from "@/core/middleware/auth";
import { validate } from "@/core/middleware/validate";
import { audit, type AuditSpec } from "@/core/middleware/audit";
import { idempotent } from "@/core/middleware/idempotency";
import type { Permission } from "@/core/auth/permissions";

export type Surface = "store" | "admin" | "webhooks" | "public";
export type AuthMode = "public" | "customer" | "optionalCustomer" | "admin";

export type Ctx<B = any, Q = any, P = any> = {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: P;
  files: Express.Multer.File[];
  /** customer id (auth: "customer") */
  customerId: string;
  admin: NonNullable<Request["admin"]>;
};

/** Wrap a result to send `{ data, meta }`. */
export class WithMeta<T> {
  constructor(public data: T, public meta: Record<string, unknown>) {}
}
export const withMeta = <T>(data: T, meta: Record<string, unknown>) => new WithMeta(data, meta);

export type RouteDef<B extends ZodType | undefined, Q extends ZodType | undefined, P extends ZodType | undefined> = {
  summary: string;
  description?: string;
  auth?: AuthMode;
  permission?: Permission | Permission[];
  body?: B;
  query?: Q;
  params?: P;
  /** HTTP status on success (default 200) */
  status?: number;
  audit?: Omit<AuditSpec, "entity"> & { entity?: string };
  /** idempotency scope name; requires the Idempotency-Key header */
  idempotent?: string;
  upload?: { field: string; maxCount?: number; maxMB?: number; accept?: RegExp };
  middleware?: RequestHandler[];
  tags?: string[];
};

type Inf<T> = T extends ZodType ? z.infer<T> : undefined;
type Handler<B, Q, P> = (ctx: Ctx<Inf<B>, Inf<Q>, Inf<P>>) => Promise<unknown> | unknown;

const upload = (u: NonNullable<RouteDef<any, any, any>["upload"]>) =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: (u.maxMB ?? 10) * 1024 * 1024, files: u.maxCount ?? 1 },
    fileFilter: (_req, file, cb) => {
      const accept = u.accept ?? /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/;
      if (accept.test(file.mimetype)) cb(null, true);
      else cb(new ApiError(400, "UNSUPPORTED_FILE", `Unsupported file type: ${file.mimetype}`));
    },
  }).array(u.field, u.maxCount ?? 1);

export class ModuleRouter {
  readonly router = express.Router({ mergeParams: true });
  constructor(
    readonly opts: { surface: Surface; prefix: string; tag: string; defaultAuth?: AuthMode; defaultPermission?: Permission },
  ) {}

  get mountPath() {
    return this.opts.surface === "public" ? this.opts.prefix : `/api/v1/${this.opts.surface}${this.opts.prefix}`;
  }

  private add<B extends ZodType | undefined, Q extends ZodType | undefined, P extends ZodType | undefined>(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    def: RouteDef<B, Q, P>,
    handler: Handler<B, Q, P>,
  ) {
    const auth = def.auth ?? this.opts.defaultAuth ?? "public";
    const chain: RequestHandler[] = [
      // route template for metrics (req.baseUrl is gone again once an error reaches the app-level handler)
      (req, res, next) => {
        res.locals.routeTemplate = `${req.baseUrl}${path}`;
        next();
      },
    ];
    if (auth === "customer") chain.push(requireCustomer);
    if (auth === "optionalCustomer") chain.push(optionalCustomer);
    if (auth === "admin") {
      chain.push(requireAdmin);
      const perms = def.permission ?? this.opts.defaultPermission;
      if (perms) chain.push(requirePermission(...(Array.isArray(perms) ? perms : [perms])));
    }
    if (def.upload) chain.push(upload(def.upload));
    if (def.middleware) chain.push(...def.middleware);
    chain.push(validate({ body: def.body, query: def.query, params: def.params }));
    if (def.idempotent) chain.push(idempotent(def.idempotent));
    if (def.audit) chain.push(audit({ entity: def.audit.entity ?? this.opts.tag.toLowerCase(), ...def.audit }));

    chain.push(async (req: Request, res: Response, _next: NextFunction) => {
      const result = await handler({
        req,
        res,
        body: req.valid.body,
        query: req.valid.query,
        params: req.valid.params,
        files: (req.files as Express.Multer.File[]) ?? [],
        customerId: req.customer?.id as string,
        admin: req.admin as NonNullable<Request["admin"]>,
      });
      if (res.headersSent) return;
      if (result === undefined && (def.status ?? 200) === 204) return void res.status(204).end();
      if (result instanceof WithMeta) return void ok(res, result.data, result.meta, def.status ?? 200);
      ok(res, result ?? null, undefined, def.status ?? 200);
    });
    this.router[method](path, ...chain);
    this.document(method, path, def, auth);
    return this;
  }

  private document(method: string, path: string, def: RouteDef<any, any, any>, auth: AuthMode) {
    const full = `${this.mountPath}${path === "/" ? "" : path}`.replace(/^\/api\/v1/, "").replace(/:(\w+)/g, "{$1}");
    const perms = def.permission ?? this.opts.defaultPermission;
    const security: Record<string, string[]>[] =
      auth === "customer" ? [{ customerAuth: [] }] : auth === "admin" ? [{ adminAuth: [] }] : auth === "optionalCustomer" ? [{ customerAuth: [] }, {}] : [];
    const desc = [def.description, perms ? `**Permission:** \`${[perms].flat().join("`, `")}\`` : "", def.idempotent ? "**Requires** `Idempotency-Key` header." : ""]
      .filter(Boolean)
      .join("\n\n");
    registry.registerPath({
      method: method as any,
      path: full || "/",
      summary: def.summary,
      description: desc || undefined,
      tags: def.tags ?? [`${this.opts.surface === "admin" ? "Admin" : this.opts.surface === "store" ? "Store" : "Other"} · ${this.opts.tag}`],
      security,
      request: {
        params: def.params as any,
        query: def.query as any,
        body: def.body
          ? { content: { [def.upload ? "multipart/form-data" : "application/json"]: { schema: def.body as any } } }
          : undefined,
      },
      responses: {
        [def.status ?? 200]: { description: "Success — `{ data, meta? }`" },
        400: { description: "VALIDATION_FAILED / business rule error" },
        ...(auth === "customer" || auth === "admin" ? { 401: { description: "UNAUTHENTICATED" } } : {}),
        ...(auth === "admin" ? { 403: { description: "FORBIDDEN" } } : {}),
      },
    });
  }

  get<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
    path: string, def: RouteDef<B, Q, P>, h: Handler<B, Q, P>) { return this.add("get", path, def, h); }
  post<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
    path: string, def: RouteDef<B, Q, P>, h: Handler<B, Q, P>) { return this.add("post", path, def, h); }
  put<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
    path: string, def: RouteDef<B, Q, P>, h: Handler<B, Q, P>) { return this.add("put", path, def, h); }
  patch<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
    path: string, def: RouteDef<B, Q, P>, h: Handler<B, Q, P>) { return this.add("patch", path, def, h); }
  delete<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined>(
    path: string, def: RouteDef<B, Q, P>, h: Handler<B, Q, P>) { return this.add("delete", path, def, h); }
}

/** Common param schemas */
export const idParam = z.object({ id: z.string().min(1).max(64) });
