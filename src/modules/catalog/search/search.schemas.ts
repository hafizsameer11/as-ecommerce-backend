import { z } from "zod";

export const searchQuery = z.object({ q: z.string().trim().min(1).max(120), limit: z.coerce.number().int().min(1).max(60).default(24) });
export const suggestQuery = z.object({ q: z.string().trim().min(1).max(60) });

export type SearchQuery = z.infer<typeof searchQuery>;
export type SuggestQuery = z.infer<typeof suggestQuery>;
