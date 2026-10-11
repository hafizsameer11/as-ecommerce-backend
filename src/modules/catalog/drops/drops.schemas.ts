import { z } from "zod";

export const notifyMeBody = z.object({ size: z.string().max(20).optional() });
export const notifyMeQuery = z.object({ size: z.string().optional() });

export type NotifyMeBody = z.infer<typeof notifyMeBody>;
export type NotifyMeQuery = z.infer<typeof notifyMeQuery>;
