import { ModuleRouter, idParam } from "@/core/http/router";
import { notificationSettingsController as c } from "./notification-settings.controller";
import { bellQuery, channelParam, channelsPatch, digestPatch, quietHoursPatch, ruleChannelParam, ruleIdParam, rulePatch } from "./notification-settings.schemas";

const audit = (action: string, entity = "notification_rule") => ({ category: "settings", action, entity, severity: "notice" as const });

/** asl-admin /notification-settings (staff alert rules) */
export const notificationSettingsAdminRoutes = new ModuleRouter({
  surface: "admin", prefix: "/notification-settings", tag: "Notification settings", defaultAuth: "admin", defaultPermission: "settings.manage",
})
  .get("/", { summary: "Alert rules (by category) + channel config, quiet hours, digest" }, c.overview)
  .patch("/rules/:id", { summary: "Edit a rule: enabled, channels, priority, recipients (role ids or e-mails)", params: ruleIdParam, body: rulePatch, audit: audit("notification_rule.updated") }, c.updateRule)
  .post("/rules/:id/toggle", { summary: "Turn a rule on / off", params: ruleIdParam, audit: audit("notification_rule.toggled") }, c.toggleRule)
  .post("/rules/:id/channels/:channel/toggle", { summary: "Turn one channel of a rule on / off", params: ruleChannelParam, audit: audit("notification_rule.channel_toggled") }, c.toggleChannel)
  .patch("/channels", { summary: "Channel configuration (e-mail sender, push, Slack, SMS)", body: channelsPatch, audit: audit("notification_channels.updated", "settings") }, c.updateChannels)
  .patch("/quiet-hours", { summary: "Quiet hours (staff e-mails held back; critical alerts optional)", body: quietHoursPatch, audit: audit("notification_quiet_hours.updated", "settings") }, c.updateQuietHours)
  .patch("/digest", { summary: "Digest schedule", body: digestPatch, audit: audit("notification_digest.updated", "settings") }, c.updateDigest)
  .post("/test/:channel", { summary: "Send a test (e-mail goes to you; Slack / SMS / push are mocked)", params: channelParam }, c.test);

/** asl-admin header bell — every signed-in team member sees their own alerts */
export const adminNotificationsRoutes = new ModuleRouter({ surface: "admin", prefix: "/notifications", tag: "Notification settings", defaultAuth: "admin" })
  .get("/", { summary: "My alerts (newest first; `unread=true` filter); meta.unread = badge", query: bellQuery }, c.bell)
  .get("/unread-count", { summary: "Bell badge count" }, c.unreadCount)
  .post("/read-all", { summary: "Mark all my alerts read" }, c.readAll)
  .post("/:id/read", { summary: "Mark one alert read", params: idParam }, c.read);
