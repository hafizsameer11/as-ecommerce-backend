import type { Response } from "express";

/** JSON can't carry BigInt (lifetime totals, ledger sums) → send as number (safe below 2^53 kobo ≈ ₦90 trillion) */
export const jsonReplacer = (_key: string, value: unknown) => (typeof value === "bigint" ? Number(value) : value);

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>, status = 200) {
  return res.status(status).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, undefined, 201);
}

export function noContent(res: Response) {
  return res.status(204).end();
}

/** send a CSV download (admin exports) */
export function sendCsv(res: Response, name: string, csv: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}
