import { z } from "zod";

export const impressionEvent = z.object({
  kind: z.enum(["banner", "announcement", "slot"]),
  id: z.string().min(1).max(64),
  event: z.enum(["impression", "click", "dismiss"]),
});

const events = z.array(impressionEvent).min(1).max(50);

/** a bare array, or `{ events: [...] }` (sendBeacon-friendly) */
export const impressionsBody = z.union([events, z.object({ events })]).transform((b) => (Array.isArray(b) ? b : b.events));

export type ImpressionEvent = z.infer<typeof impressionEvent>;
export type ImpressionsBody = z.infer<typeof impressionsBody>;
