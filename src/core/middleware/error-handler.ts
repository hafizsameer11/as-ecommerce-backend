import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/core/http/errors";
import { logger } from "@/core/utils/logger";
import multer from "multer";
import { ZodError } from "zod";

export function notFoundHandler(req: Request, _res: Response) {
  throw new ApiError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`);
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let e: ApiError;
  if (err instanceof ApiError) e = err;
  else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") e = ApiError.notFound();
  else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
    e = ApiError.conflict("CONFLICT", "This value is already in use.", { fields: err.meta?.target });
  else if (err instanceof ZodError)
    e = ApiError.badRequest("VALIDATION_FAILED", "Please check the highlighted fields.", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  else if (err instanceof multer.MulterError) e = ApiError.badRequest("UNSUPPORTED_FILE", err.message);
  else if (err instanceof SyntaxError && "body" in (err as object)) e = ApiError.badRequest("VALIDATION_FAILED", "Malformed JSON body.");
  else {
    logger.error({ err, reqId: req.id }, "Unhandled error");
    e = new ApiError(500, "INTERNAL", "Something went wrong. Please try again.");
  }
  if (e.status >= 500) logger.error({ err, reqId: req.id }, e.message);
  res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details, requestId: req.id } });
}
