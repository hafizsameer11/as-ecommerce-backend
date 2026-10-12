import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** inbox tabs as the apps spell them (DB enum stores "ASL Club" as ASLClub) */
export const NOTIFICATION_CATEGORIES = ["Orders", "Offers", "Account", "Wishlist", "ASL Club", "Updates"] as const;
export type NotificationCategoryLabel = (typeof NOTIFICATION_CATEGORIES)[number];

export const PREF_CHANNELS = ["push", "email", "sms"] as const;
export const PREF_TOPICS = ["orders", "concierge", "shipping", "promos", "wishlist"] as const;
export type PrefChannel = (typeof PREF_CHANNELS)[number];
export type PrefTopic = (typeof PREF_TOPICS)[number];

export const inboxQuery = pageQuery.extend({
  category: z.enum([...NOTIFICATION_CATEGORIES, "All"]).optional(),
  unread: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export const preferencesBody = z.object({
  channels: z.object({ push: z.boolean(), email: z.boolean(), sms: z.boolean() }).partial().optional(),
  topics: z.object({ orders: z.boolean(), concierge: z.boolean(), shipping: z.boolean(), promos: z.boolean(), wishlist: z.boolean() }).partial().optional(),
});

export const readAllBody = z.object({ category: z.enum(NOTIFICATION_CATEGORIES).optional() }).default({});

export type ReadAllBody = z.infer<typeof readAllBody>;
export type InboxQuery = z.infer<typeof inboxQuery>;
export type PreferencesBody = z.infer<typeof preferencesBody>;
