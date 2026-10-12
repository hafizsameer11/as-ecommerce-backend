import type { Ctx } from "@/core/http/router";
import { notificationsService as svc } from "./notifications.service";
import type { InboxQuery, PreferencesBody, ReadAllBody } from "./notifications.schemas";

type Id = { id: string };

export const notificationsController = {
  list: ({ customerId, query }: Ctx<unknown, InboxQuery>) => svc.list(customerId, query),
  unreadCount: ({ customerId }: Ctx) => svc.unreadCount(customerId),
  read: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.markRead(customerId, params.id),
  readAll: ({ customerId, body }: Ctx<ReadAllBody>) => svc.markAllRead(customerId, body?.category),
  remove: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.remove(customerId, params.id),
  preferences: ({ customerId }: Ctx) => svc.preferences(customerId),
  updatePreferences: ({ customerId, body }: Ctx<PreferencesBody>) => svc.updatePreferences(customerId, body),
};
