import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { ApiError } from "@/core/http/errors";

export type Schemas = { body?: ZodType; query?: ZodType; params?: ZodType };

export function validate(s: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const out: Request["valid"] = { body: req.body, query: req.query, params: req.params };
    const issues: { in: string; path: string; message: string }[] = [];
    for (const key of ["body", "query", "params"] as const) {
      const schema = s[key];
      if (!schema) continue;
      const r = schema.safeParse(key === "body" ? (req.body ?? {}) : req[key]);
      if (r.success) out[key] = r.data;
      else for (const i of r.error.issues) issues.push({ in: key, path: i.path.join("."), message: i.message });
    }
    if (issues.length) throw ApiError.badRequest("VALIDATION_FAILED", "Please check the highlighted fields.", issues);
    req.valid = out;
    next();
  };
}
