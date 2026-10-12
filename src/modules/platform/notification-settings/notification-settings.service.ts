/**
 * Staff alerts: NotificationRule (admin /notification-settings) → AdminNotification rows (header bell),
 * e-mail to the recipients, and mocked push / Slack / SMS.
 */
import type { Prisma, AdminNotification, NotificationRule } from "@/generated/prisma/client";
import type { AdminRole } from "@/generated/prisma/enums";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { logger } from "@/core/utils/logger";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import {
  STAFF_CHANNELS, type BellQuery, type ChannelsPatch, type DigestPatch, type QuietHoursPatch, type RulePatch, type StaffChannel,
} from "./notification-settings.schemas";

type Channels = Record<StaffChannel, boolean>;
type StaffAlerts = SettingsOf<"staffAlerts">;

export const RULE_CATEGORIES = [
  { id: "orders", label: "Orders & sales" },
  { id: "concierge", label: "Concierge" },
  { id: "catalog", label: "Catalog & inventory" },
  { id: "customers", label: "Customers & support" },
  { id: "finance", label: "Finance" },
  { id: "system", label: "System & security" },
] as const;

const channelsOf = (r: NotificationRule): Channels => {
  const c = (r.channels ?? {}) as Partial<Channels>;
  return Object.fromEntries(STAFF_CHANNELS.map((k) => [k, !!c[k]])) as Channels;
};

const toRule = (r: NotificationRule) => ({
  id: r.id, category: r.category, label: r.label, description: r.description,
  channels: channelsOf(r), recipients: (r.recipients as string[] | null) ?? [], priority: r.priority, enabled: r.enabled,
});

const toBell = (n: AdminNotification) => ({
  id: n.id, ruleId: n.ruleId, title: n.title, body: n.body, link: n.link, priority: n.priority,
  read: !!n.readAt, readAt: n.readAt, createdAt: n.createdAt, scope: n.adminId ? "me" : "role",
});

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** true when `now` falls inside the quiet-hours window (handles windows across midnight) */
export function inQuietHours(q: StaffAlerts["quietHours"], now = new Date()) {
  if (!q.enabled) return false;
  let local: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: q.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    local = minutes(parts);
  } catch {
    local = now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const start = minutes(q.start);
  const end = minutes(q.end);
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

export type StaffAlert = {
  title: string;
  body: string;
  /** admin-app path, e.g. `/orders?id=…` */
  link?: string;
  /** what the alert is about (e.g. `order:ID`, `sku:ABC`) — logged with mocked channels */
  entity?: string;
  /** also notify this admin (assignee), whatever the rule's recipients */
  adminId?: string | null;
  /** skip when the same rule already created a row with the same `link` within this window */
  dedupeHours?: number;
};

/**
 * Fire a staff rule. Respects the rule's `enabled`, `channels` and `recipients` (role ids → every active admin with
 * that role; e-mails → that address, plus the bell when it belongs to an admin). One bell row per admin, so read
 * state is personal. E-mail is held back during quiet hours unless the rule is critical and `exceptCritical` is on.
 * Never throws (alerts must not break the business action).
 */
export async function notifyStaff(ruleId: string, n: StaffAlert) {
  try {
    const rule = await prisma.notificationRule.findUnique({ where: { id: ruleId } });
    if (!rule || !rule.enabled) return { inApp: 0, emails: 0 };
    const ch = channelsOf(rule);
    const recipients = (rule.recipients as string[] | null) ?? [];
    const roles = recipients.filter((r) => !r.includes("@")) as AdminRole[];
    const emails = recipients.filter((r) => r.includes("@")).map((e) => e.toLowerCase());
    const admins = await prisma.adminUser.findMany({
      where: { status: "active", OR: [{ role: { in: roles } }, { email: { in: emails } }, ...(n.adminId ? [{ id: n.adminId }] : [])] },
      select: { id: true, email: true, role: true },
    });
    if (n.dedupeHours && n.link) {
      const since = new Date(Date.now() - n.dedupeHours * 3_600_000);
      const dup = await prisma.adminNotification.findFirst({ where: { ruleId, link: n.link, createdAt: { gte: since } }, select: { id: true } });
      if (dup) return { inApp: 0, emails: 0 };
    }

    let inApp = 0;
    if (ch.in_app && admins.length) {
      const data: Prisma.AdminNotificationCreateManyInput[] = admins.map((a) => ({
        adminId: a.id, role: a.role, ruleId, title: n.title, body: n.body, link: n.link ?? null, priority: rule.priority,
      }));
      inApp = (await prisma.adminNotification.createMany({ data })).count;
    }

    let sent = 0;
    if (ch.email) {
      const cfg = await settingsService.get("staffAlerts");
      const quiet = inQuietHours(cfg.quietHours) && !(rule.priority === "critical" && cfg.quietHours.exceptCritical);
      if (!quiet) {
        const to = [...new Set([...admins.map((a) => a.email.toLowerCase()), ...emails])];
        for (const addr of to) {
          await messaging.email(addr, "staff.alert", { title: n.title, body: n.body, rule: rule.label, priority: rule.priority, url: n.link ?? "" });
          sent++;
        }
      }
    }
    // push (admin app has no device tokens yet), Slack and SMS are not wired: log only
    if (ch.push || ch.slack || ch.sms) logger.info({ ruleId, entity: n.entity, push: ch.push, slack: ch.slack, sms: ch.sms, title: n.title }, "staff alert (mock channels)");
    return { inApp, emails: sent };
  } catch (err) {
    logger.error({ err, ruleId }, "staff notification failed");
    return { inApp: 0, emails: 0 };
  }
}

/** bell rows for one admin: own rows + legacy role-wide rows (e.g. concierge alerts) */
const mine = (admin: { id: string; role: AdminRole }): Prisma.AdminNotificationWhereInput => ({
  OR: [{ adminId: admin.id }, { adminId: null, role: admin.role }],
});

async function findRule(id: string) {
  const r = await prisma.notificationRule.findUnique({ where: { id } });
  if (!r) throw ApiError.notFound("Notification rule");
  return r;
}

export const notificationSettingsService = {
  // ── admin /notification-settings ──
  async overview() {
    const [rules, cfg] = await Promise.all([
      prisma.notificationRule.findMany({ orderBy: [{ category: "asc" }, { id: "asc" }] }),
      settingsService.get("staffAlerts"),
    ]);
    const order: string[] = RULE_CATEGORIES.map((c) => c.id);
    const sorted = rules.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    return { rules: sorted.map(toRule), channels: cfg.channels, quietHours: cfg.quietHours, digest: cfg.digest, categories: RULE_CATEGORIES };
  },

  async updateRule(id: string, patch: RulePatch) {
    const r = await findRule(id);
    const before = toRule(r);
    const updated = await prisma.notificationRule.update({
      where: { id },
      data: {
        enabled: patch.enabled,
        priority: patch.priority,
        recipients: patch.recipients ? [...new Set(patch.recipients)] : undefined,
        channels: patch.channels ? { ...channelsOf(r), ...patch.channels } : undefined,
      },
    });
    return { before, after: toRule(updated) };
  },

  async toggleRule(id: string) {
    const r = await findRule(id);
    return this.updateRule(id, { enabled: !r.enabled });
  },

  async toggleChannel(id: string, channel: StaffChannel) {
    const r = await findRule(id);
    return this.updateRule(id, { channels: { [channel]: !channelsOf(r)[channel] } });
  },

  async updateChannels(patch: ChannelsPatch, by: string) {
    const cur = await settingsService.get("staffAlerts");
    const channels = {
      email: { ...cur.channels.email, ...patch.email },
      push: { ...cur.channels.push, ...patch.push },
      slack: { ...cur.channels.slack, ...patch.slack },
      sms: { ...cur.channels.sms, ...patch.sms },
    };
    const r = await settingsService.update("staffAlerts", { channels }, by);
    return { before: r.before.channels, after: r.after.channels };
  },

  async updateQuietHours(patch: QuietHoursPatch, by: string) {
    const cur = await settingsService.get("staffAlerts");
    const r = await settingsService.update("staffAlerts", { quietHours: { ...cur.quietHours, ...patch } }, by);
    return { before: r.before.quietHours, after: r.after.quietHours };
  },

  async updateDigest(patch: DigestPatch, by: string) {
    const cur = await settingsService.get("staffAlerts");
    const r = await settingsService.update("staffAlerts", { digest: { ...cur.digest, ...patch } }, by);
    return { before: r.before.digest, after: r.after.digest };
  },

  /** "Send test": e-mail goes to the caller for real; the other channels are mocked */
  async test(channel: StaffChannel, admin: { id: string; email: string; name: string; role: AdminRole }) {
    const title = "Test notification";
    const body = `Hi ${admin.name}, this is a test from ASL ORIGINALS Admin → Notification settings.`;
    switch (channel) {
      case "email":
        await messaging.email(admin.email, "staff.alert", { title, body, rule: "Test", priority: "normal", url: "/notification-settings" });
        return { channel, sent: true, message: `Test email queued to ${admin.email}` };
      case "in_app":
        await prisma.adminNotification.create({ data: { adminId: admin.id, role: admin.role, title, body, link: "/notification-settings", priority: "normal" } });
        return { channel, sent: true, message: "Test notification added to your bell" };
      case "slack": {
        const cfg = await settingsService.get("staffAlerts");
        return { channel, sent: false, mocked: true, message: `Slack test posted to ${cfg.channels.slack.channel} (mock — Slack is not connected yet)` };
      }
      case "push":
        return { channel, sent: false, mocked: true, message: "Push test sent (mock — the admin app has no push devices yet)" };
      case "sms":
        return { channel, sent: false, mocked: true, message: "SMS test sent (mock — SMS alerts for staff are not wired yet)" };
    }
  },

  // ── admin header bell (/admin/notifications) ──
  async bell(admin: { id: string; role: AdminRole }, q: BellQuery) {
    const base = mine(admin);
    const where: Prisma.AdminNotificationWhereInput = q.unread === undefined ? base : { AND: [base, { readAt: q.unread ? null : { not: null } }] };
    const [rows, total, unread] = await Promise.all([
      prisma.adminNotification.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.adminNotification.count({ where }),
      prisma.adminNotification.count({ where: { AND: [base, { readAt: null }] } }),
    ]);
    return withMeta(rows.map(toBell), { ...pageMeta(q, total), unread });
  },

  async unreadCount(admin: { id: string; role: AdminRole }) {
    return { unread: await prisma.adminNotification.count({ where: { AND: [mine(admin), { readAt: null }] } }) };
  },

  async markRead(admin: { id: string; role: AdminRole }, id: string) {
    const n = await prisma.adminNotification.findFirst({ where: { AND: [mine(admin), { id }] } });
    if (!n) throw ApiError.notFound("Notification");
    const row = n.readAt ? n : await prisma.adminNotification.update({ where: { id }, data: { readAt: new Date() } });
    return toBell(row);
  },

  async markAllRead(admin: { id: string; role: AdminRole }) {
    const { count } = await prisma.adminNotification.updateMany({ where: { AND: [mine(admin), { readAt: null }] }, data: { readAt: new Date() } });
    return { updated: count };
  },
};
