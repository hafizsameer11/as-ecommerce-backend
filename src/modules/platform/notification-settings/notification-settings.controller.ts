import type { Ctx } from "@/core/http/router";
import { notificationSettingsService as svc } from "./notification-settings.service";
import type { StaffChannel, BellQuery, ChannelsPatch, DigestPatch, QuietHoursPatch, RulePatch } from "./notification-settings.schemas";

type Id = { id: string };

export const notificationSettingsController = {
  // admin /notification-settings
  overview: () => svc.overview(),
  updateRule: async ({ params, body, res }: Ctx<RulePatch, unknown, Id>) => {
    const r = await svc.updateRule(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Updated alert rule "${r.after.label}"` };
    return r.after;
  },
  toggleRule: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.toggleRule(params.id);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `${r.after.enabled ? "Enabled" : "Disabled"} alert rule "${r.after.label}"` };
    return r.after;
  },
  toggleChannel: async ({ params, res }: Ctx<unknown, unknown, Id & { channel: StaffChannel }>) => {
    const r = await svc.toggleChannel(params.id, params.channel);
    res.locals.audit = {
      entityId: params.id, before: r.before, after: r.after,
      summary: `${r.after.channels[params.channel] ? "Enabled" : "Disabled"} ${params.channel} for "${r.after.label}"`,
    };
    return r.after;
  },
  updateChannels: async ({ body, admin, res }: Ctx<ChannelsPatch>) => {
    const r = await svc.updateChannels(body, admin.name);
    res.locals.audit = { entityId: "channels", before: r.before, after: r.after, summary: "Updated staff alert channels" };
    return r.after;
  },
  updateQuietHours: async ({ body, admin, res }: Ctx<QuietHoursPatch>) => {
    const r = await svc.updateQuietHours(body, admin.name);
    res.locals.audit = { entityId: "quiet_hours", before: r.before, after: r.after, summary: "Updated staff alert quiet hours" };
    return r.after;
  },
  updateDigest: async ({ body, admin, res }: Ctx<DigestPatch>) => {
    const r = await svc.updateDigest(body, admin.name);
    res.locals.audit = { entityId: "digest", before: r.before, after: r.after, summary: "Updated staff alert digest" };
    return r.after;
  },
  test: ({ params, admin }: Ctx<unknown, unknown, { channel: StaffChannel }>) => svc.test(params.channel, admin),

  // admin header bell
  bell: ({ query, admin }: Ctx<unknown, BellQuery>) => svc.bell(admin, query),
  unreadCount: ({ admin }: Ctx) => svc.unreadCount(admin),
  read: ({ params, admin }: Ctx<unknown, unknown, Id>) => svc.markRead(admin, params.id),
  readAll: ({ admin }: Ctx) => svc.markAllRead(admin),
};
