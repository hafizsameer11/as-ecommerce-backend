import { z } from "zod";

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(60).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export function paging(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function pageMeta(q: { page: number; pageSize: number }, total: number) {
  return { page: q.page, pageSize: q.pageSize, total, pageCount: Math.max(1, Math.ceil(total / q.pageSize)) };
}

/** "-createdAt" → { createdAt: "desc" }; only keys in `allowed` are accepted. */
export function orderBy<T extends string>(sort: string | undefined, allowed: readonly T[], fallback: string) {
  const s = sort && allowed.includes(sort.replace(/^-/, "") as T) ? sort : fallback;
  const desc = s.startsWith("-");
  return { [s.replace(/^-/, "")]: desc ? "desc" : "asc" } as Record<string, "asc" | "desc">;
}
