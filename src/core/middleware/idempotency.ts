import type { NextFunction, Request, Response } from "express";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";

/**
 * Requires an `Idempotency-Key` header. A repeated key replays the first response,
 * so double taps / retries never place two orders or charge twice.
 */
export function idempotent(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = req.header("Idempotency-Key");
    if (!raw || raw.length < 8 || raw.length > 128)
      throw ApiError.badRequest("VALIDATION_FAILED", "Idempotency-Key header (8–128 chars) is required for this action.");
    const owner = req.customer?.id ?? req.admin?.id ?? req.anonId ?? "anon";
    const key = `${scope}:${owner}:${raw}`;

    const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (existing) {
      if (existing.statusCode === 0) throw ApiError.conflict("IDEMPOTENCY_IN_PROGRESS", "This request is already being processed.");
      res.setHeader("Idempotent-Replay", "true");
      return res.status(existing.statusCode).json(existing.response);
    }
    try {
      await prisma.idempotencyKey.create({ data: { key, scope, statusCode: 0, response: {} } });
    } catch {
      throw ApiError.conflict("IDEMPOTENCY_IN_PROGRESS", "This request is already being processed.");
    }

    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      // only successful responses are replayed; failures free the key so the client can retry
      const p =
        status < 400
          ? prisma.idempotencyKey.update({ where: { key }, data: { statusCode: status, response: body as object } })
          : prisma.idempotencyKey.delete({ where: { key } });
      p.catch(() => undefined);
      return json(body);
    };
    next();
  };
}
