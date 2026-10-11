import { z } from "zod";

const carrier = z
  .enum(["DHL", "FedEx", "UPS", "GIG", "Aramex", "Local", "InHouse", "In-house"])
  .transform((c) => (c === "In-house" ? "InHouse" : c) as "DHL" | "FedEx" | "UPS" | "GIG" | "Aramex" | "Local" | "InHouse");

export const rateBody = z.object({
  name: z.string().trim().min(1).max(80),
  carrier,
  service: z.string().trim().max(80).default(""),
  baseFee: z.number().int().min(0),
  perKgFee: z.number().int().min(0).default(0),
  minKg: z.number().min(0).default(0),
  maxKg: z.number().min(0).default(1000),
  etaDays: z.string().trim().max(60),
  freeAbove: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
  position: z.number().int().optional(),
});

export const zoneBody = z.object({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["country", "state", "city", "postcode"]).default("country"),
  countries: z.array(z.string().trim().min(1).max(3)).min(1).default(["NG"]),
  regions: z.array(z.string().trim().min(1).max(80)).default([]),
  /** lower number wins when zones overlap (same as the admin screen) */
  priority: z.number().int().min(0).max(1000).default(10),
  active: z.boolean().default(true),
  notes: z.string().max(2000).nullable().optional(),
  rates: z.array(rateBody).optional(),
});

export const quoteQuery = z.object({
  country: z.string().trim().min(2).max(56).default("NG"),
  state: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  postcode: z.string().trim().max(20).optional(),
  subtotal: z.coerce.number().int().min(0).default(0),
  weightKg: z.coerce.number().min(0).optional(),
});

export type RateBody = z.infer<typeof rateBody>;
export type ZoneBody = z.infer<typeof zoneBody>;
export type QuoteQuery = z.infer<typeof quoteQuery>;
