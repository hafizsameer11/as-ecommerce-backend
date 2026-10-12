import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

// ── POST /store/events ──
export const EVENT_NAMES = ["page_view", "product_view", "add_to_cart", "checkout_start", "search"] as const;
export const DEVICES = ["mobile", "desktop", "tablet"] as const;
export const SOURCES = ["direct", "organic", "social", "paid", "email", "referral"] as const;
export type TrafficSource = (typeof SOURCES)[number];

/** one event; parsed one by one so a bad event is dropped instead of failing the batch */
export const clientEvent = z.object({
  name: z.enum(EVENT_NAMES),
  anonId: z.string().regex(/^[\w-]{8,64}$/).optional(),
  sessionId: z.string().regex(/^[\w.:-]{4,64}$/).optional(),
  path: z.string().trim().max(512).optional(),
  /** product id or handle (product_view, add_to_cart) */
  productId: z.string().trim().min(1).max(80).optional(),
  /** search term (search) — stored as the path `/search?q=…` */
  query: z.string().trim().max(200).optional(),
  device: z.enum(DEVICES).optional(),
  channel: z.enum(["web", "mobile", "pwa"]).optional(),
  utm: z
    .object({
      source: z.string().trim().max(100).optional(),
      medium: z.string().trim().max(100).optional(),
      campaign: z.string().trim().max(150).optional(),
    })
    .optional(),
  referrer: z.string().trim().max(512).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
});
export type ClientEvent = z.infer<typeof clientEvent>;

export const eventsBody = z.object({
  /** shared defaults for every event in the batch */
  anonId: z.string().max(64).optional(),
  sessionId: z.string().max(64).optional(),
  events: z.array(z.unknown()).min(1).max(50),
});
export type EventsBody = z.infer<typeof eventsBody>;

// ── admin screens ──
const range = z.enum(["7d", "14d", "30d", "90d", "12m"]).default("30d");

export const salesQuery = z.object({
  range,
  channel: z.enum(["all", "web", "mobile", "pwa", "concierge", "draft"]).default("all"),
  country: z.string().regex(/^(all|[A-Za-z]{2})$/).default("all").transform((s) => (s === "all" ? s : s.toUpperCase())),
});
export type SalesQuery = z.infer<typeof salesQuery>;

export const productsQuery = pageQuery.extend({
  range,
  /** category handle or id */
  category: z.string().max(80).default("all"),
  sort: z.enum(["revenue", "units", "views", "conv", "margin"]).default("revenue"),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ProductsQuery = z.infer<typeof productsQuery>;

export const trafficQuery = z.object({
  range,
  device: z.enum(["all", ...DEVICES]).default("all"),
  source: z.enum(["all", ...SOURCES]).default("all"),
});
export type TrafficQuery = z.infer<typeof trafficQuery>;

export const cohortsQuery = z.object({
  window: z.enum(["6m", "12m", "24m"]).default("12m"),
  metric: z.enum(["retention", "revenue", "orders"]).default("retention"),
});
export type CohortsQuery = z.infer<typeof cohortsQuery>;

export const conciergeQuery = z.object({
  range,
  priority: z.enum(["all", "standard", "priority", "vip"]).default("all"),
});
export type ConciergeQuery = z.infer<typeof conciergeQuery>;

export const rebuildBody = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type RebuildBody = z.infer<typeof rebuildBody>;
