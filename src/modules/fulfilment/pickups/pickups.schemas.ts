import { z } from "zod";

export const locationBody = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(3).max(190),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  country: z.string().trim().length(2).default("NG"),
  phone: z.string().trim().min(7).max(30),
  hours: z.string().trim().max(190),
  active: z.boolean().default(true),
  concierge: z.boolean().default(false),
  capacityPerDay: z.number().int().min(1).max(10_000).default(40),
});
export type LocationBody = z.infer<typeof locationBody>;
