/**
 * Customer notification centre: inbox rows (/account/notifications, bell badge) + delivery on the
 * channels the customer allows (NotificationPreference: channels push/email/sms × topics).
 *
 * `notify()` is the producer every module can use. It always writes the inbox row; push / e-mail / SMS
 * go out only when both the channel and the topic are on.
 */
import type { Notification, Prisma } from "@/generated/prisma/client";
import type { NotificationCategory } from "@/generated/prisma/enums";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { logger } from "@/core/utils/logger";
import { push } from "@/providers/push/push";
import { realtime } from "@/core/realtime/realtime";
import { messaging, type Vars as TemplateVars } from "@/modules/marketing/messaging/messaging.service";
import {
  NOTIFICATION_CATEGORIES, PREF_CHANNELS, PREF_TOPICS,
  type InboxQuery, type NotificationCategoryLabel, type PrefChannel, type PreferencesBody, type PrefTopic,
} from "./notifications.schemas";

type Vars = Record<string, string | number | undefined | null>;
export type Preferences = { channels: Record<PrefChannel, boolean>; topics: Record<PrefTopic, boolean> };

/** same defaults as /account/notifications/settings */
export const DEFAULT_PREFERENCES: Preferences = {
  channels: { push: true, email: true, sms: false },
  topics: { orders: true, concierge: true, shipping: true, promos: false, wishlist: true },
};

const toDb = (c: NotificationCategoryLabel): NotificationCategory => (c === "ASL Club" ? "ASLClub" : c);
const fromDb = (c: NotificationCategory): NotificationCategoryLabel => (c === "ASLClub" ? "ASL Club" : c);

/** topic that gates delivery when the producer doesn't name one (null = always allowed: account / club notices) */
const DEFAULT_TOPIC: Record<NotificationCategoryLabel, PrefTopic | null> = {
  Orders: "orders", Offers: "promos", Updates: "promos", Wishlist: "wishlist", Account: null, "ASL Club": null,
};

export const toInboxDto = (n: Notification) => ({
  id: n.id, category: fromDb(n.category), tag: n.tag, title: n.title, message: n.message,
  cta: n.ctaLabel, ctaLabel: n.ctaLabel, ctaTo: n.ctaHref, ctaLink: n.ctaHref, icon: n.icon,
  unread: !n.readAt, readAt: n.readAt, createdAt: n.createdAt,
});

function normalise(row: { channels: unknown; topics: unknown } | null): Preferences {
  const c = (row?.channels ?? {}) as Partial<Preferences["channels"]>;
  const t = (row?.topics ?? {}) as Partial<Preferences["topics"]>;
  return {
    channels: Object.fromEntries(PREF_CHANNELS.map((k) => [k, typeof c[k] === "boolean" ? c[k] : DEFAULT_PREFERENCES.channels[k]])) as Preferences["channels"],
    topics: Object.fromEntries(PREF_TOPICS.map((k) => [k, typeof t[k] === "boolean" ? t[k] : DEFAULT_PREFERENCES.topics[k]])) as Preferences["topics"],
  };
}

export async function getPreferences(customerId: string): Promise<Preferences> {
  return normalise(await prisma.notificationPreference.findUnique({ where: { customerId } }));
}

/**
 * May a customer-facing message go out to this customer on `channel`?
 * Both the channel switch and the topic must be on; `topic: null` = account notice (only the channel switch counts).
 *
 * THE RULE (used by every module):
 *  - push + SMS to a customer with an account → always follow these preferences;
 *  - promotional / reminder e-mail (cart reminders …) → follows them too;
 *  - transactional e-mail (order confirmed / shipped / cancelled, refunds + returns, receipts / invoices, password reset,
 *    OTP, pay links, ticket and concierge replies to the contact address, staff alerts) → ALWAYS sent, never gated;
 *  - OTP SMS → always sent (it is how people sign in);
 *  - guests (no account, so no preferences) → transactional messages always go out.
 */
export async function shouldSend(customerId: string, topic: PrefTopic | null, channel: PrefChannel) {
  const p = await getPreferences(customerId);
  return p.channels[channel] && (topic === null || p.topics[topic]);
}

/**
 * messaging.* with the customer's preferences applied (see `shouldSend`). Never throws.
 * Returns true when the message was handed to the provider.
 */
export const preferred = {
  async push(customerId: string | null | undefined, topic: PrefTopic | null, code: string, vars: TemplateVars, data?: Record<string, string>) {
    if (!customerId) return false;
    try {
      if (!(await shouldSend(customerId, topic, "push"))) return false;
      await messaging.push(customerId, code, vars, data);
      return true;
    } catch (err) {
      logger.error({ err, code }, "preferred push failed");
      return false;
    }
  },
  /** guests (no customerId) get transactional SMS; account holders only when SMS + topic are on */
  async sms(customerId: string | null | undefined, phone: string | null | undefined, topic: PrefTopic | null, code: string, vars: TemplateVars) {
    if (!phone) return false;
    try {
      if (customerId && !(await shouldSend(customerId, topic, "sms"))) return false;
      await messaging.sms(phone, code, vars);
      return true;
    } catch (err) {
      logger.error({ err, code }, "preferred sms failed");
      return false;
    }
  },
  /** promotional / reminder mail: account holders only when e-mail + topic are on (guests: always) */
  async promoEmail(customerId: string | null | undefined, to: string | null | undefined, topic: PrefTopic | null, code: string, vars: TemplateVars) {
    if (!to) return false;
    try {
      if (customerId && !(await shouldSend(customerId, topic, "email"))) return false;
      await messaging.email(to, code, vars);
      return true;
    } catch (err) {
      logger.error({ err, code }, "preferred email failed");
      return false;
    }
  },
};

export type NotifyInput = {
  category: NotificationCategoryLabel;
  title: string;
  message: string;
  ctaLabel?: string;
  ctaLink?: string;
  /** lucide icon name the apps render (Package, Truck, RefreshCw, Crown …) */
  icon?: string;
  /** small badge, e.g. NEW */
  tag?: string;
  /** preference topic gating push / e-mail / SMS (default from the category; null = not gated by topic) */
  topic?: PrefTopic | null;
  /** message template (MessageTemplate code) sent on every allowed channel that has a template for it */
  template?: { code: string; vars?: Vars; data?: Record<string, string> };
  /** limit template delivery to these channels (e.g. the e-mail already went out elsewhere) */
  channels?: PrefChannel[];
  /** without a template: also send `title` / `message` as a push (when allowed) */
  push?: boolean;
  /** write the inbox row (default true) */
  inbox?: boolean;
};

/**
 * Write an inbox row and deliver on the channels the customer allows.
 * Never throws: notifications must not break the action that produced them.
 */
export async function notify(customerId: string, input: NotifyInput) {
  const delivered: Record<PrefChannel, boolean> = { push: false, email: false, sms: false };
  try {
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, phone: true, deletedAt: true } });
    if (!c || c.deletedAt) return { notification: null, delivered };
    const row = input.inbox === false ? null : await prisma.notification.create({
      data: {
        customerId, category: toDb(input.category), title: input.title.slice(0, 190), message: input.message,
        ctaLabel: input.ctaLabel ?? null, ctaHref: input.ctaLink ?? null, icon: input.icon ?? null, tag: input.tag ?? null,
      },
    });
    if (row) realtime.emit(`customer:${customerId}`, "notification.new", toInboxDto(row));
    const prefs = await getPreferences(customerId);
    const topic = input.topic === undefined ? DEFAULT_TOPIC[input.category] : input.topic;
    const allowed = (ch: PrefChannel) => (!input.channels || input.channels.includes(ch)) && prefs.channels[ch] && (topic === null || prefs.topics[topic]);
    const data = { type: "notification", ...(row ? { notificationId: row.id } : {}), ...(input.template?.data ?? {}), ...(input.ctaLink ? { link: input.ctaLink } : {}) };

    if (input.template) {
      const { code, vars = {} } = input.template;
      if (allowed("push") && (await messaging.render(code, "push", vars))) {
        await messaging.push(customerId, code, vars, data);
        delivered.push = true;
      }
      if (allowed("email") && c.email && (await messaging.render(code, "email", vars))) {
        await messaging.email(c.email, code, vars);
        delivered.email = true;
      }
      if (allowed("sms") && c.phone && (await messaging.render(code, "sms", vars))) {
        await messaging.sms(c.phone, code, vars);
        delivered.sms = true;
      }
    } else if (input.push && allowed("push")) {
      const tokens = await prisma.pushToken.findMany({ where: { customerId }, select: { token: true } });
      if (tokens.length) {
        await push.send({ tokens: tokens.map((t) => t.token), title: input.title, body: input.message, data });
        delivered.push = true;
      }
    }
    return { notification: row ? toInboxDto(row) : null, delivered };
  } catch (err) {
    logger.error({ err, customerId, title: input.title }, "customer notification failed");
    return { notification: null, delivered };
  }
}

const mine = (customerId: string, id: string) => prisma.notification.findFirst({ where: { id, customerId } });

export const notificationsService = {
  notify,
  getPreferences,
  shouldSend,

  async list(customerId: string, q: InboxQuery) {
    const base: Prisma.NotificationWhereInput = { customerId };
    const where: Prisma.NotificationWhereInput = {
      ...base,
      category: q.category && q.category !== "All" ? toDb(q.category) : undefined,
      readAt: q.unread === undefined ? undefined : q.unread ? null : { not: null },
    };
    const [rows, total, unread, groups] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { ...base, readAt: null } }),
      prisma.notification.groupBy({ by: ["category"], where: { ...base, readAt: null }, _count: { _all: true } }),
    ]);
    const unreadByCategory = Object.fromEntries(NOTIFICATION_CATEGORIES.map((cat) => [cat, groups.find((g) => fromDb(g.category) === cat)?._count._all ?? 0]));
    return withMeta(rows.map(toInboxDto), { ...pageMeta(q, total), unread, tabs: { All: unread, ...unreadByCategory }, categories: ["All", ...NOTIFICATION_CATEGORIES] });
  },

  async unreadCount(customerId: string) {
    return { unread: await prisma.notification.count({ where: { customerId, readAt: null } }) };
  },

  async markRead(customerId: string, id: string) {
    const n = await mine(customerId, id);
    if (!n) throw ApiError.notFound("Notification");
    return toInboxDto(n.readAt ? n : await prisma.notification.update({ where: { id }, data: { readAt: new Date() } }));
  },

  async markAllRead(customerId: string, category?: NotificationCategoryLabel) {
    const { count } = await prisma.notification.updateMany({ where: { customerId, readAt: null, category: category ? toDb(category) : undefined }, data: { readAt: new Date() } });
    return { updated: count };
  },

  async remove(customerId: string, id: string) {
    const n = await mine(customerId, id);
    if (!n) throw ApiError.notFound("Notification");
    await prisma.notification.delete({ where: { id } });
    return { deleted: true };
  },

  async preferences(customerId: string) {
    return getPreferences(customerId);
  },

  async updatePreferences(customerId: string, body: PreferencesBody) {
    const cur = await getPreferences(customerId);
    const next: Preferences = { channels: { ...cur.channels, ...body.channels }, topics: { ...cur.topics, ...body.topics } };
    await prisma.notificationPreference.upsert({
      where: { customerId },
      create: { customerId, channels: next.channels, topics: next.topics },
      update: { channels: next.channels, topics: next.topics },
    });
    return next;
  },
};
