import { ModuleRouter, idParam } from "@/core/http/router";
import { notificationsController as c } from "./notifications.controller";
import { inboxQuery, preferencesBody, readAllBody } from "./notifications.schemas";

/** /account/notifications (inbox + bell badge) */
export const myNotificationsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/notifications", tag: "Notifications", defaultAuth: "customer" })
  .get("/", { summary: "My notifications (tabs: All / Orders / Offers / Account / Wishlist / ASL Club / Updates); meta.unread + per-tab unread", query: inboxQuery }, c.list)
  .get("/unread-count", { summary: "Bell badge count" }, c.unreadCount)
  .post("/read-all", { summary: "Mark all read (optionally one category)", body: readAllBody }, c.readAll)
  .post("/:id/read", { summary: "Mark one read", params: idParam }, c.read)
  .delete("/:id", { summary: "Delete a notification", params: idParam }, c.remove);

/** /account/notifications/settings */
export const myNotificationPreferencesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/notification-preferences", tag: "Notifications", defaultAuth: "customer" })
  .get("/", { summary: "Channels (push / email / sms) and topics (orders / concierge / shipping / promos / wishlist)" }, c.preferences)
  .put("/", { summary: "Update channels / topics (partial objects are merged)", body: preferencesBody }, c.updatePreferences);
