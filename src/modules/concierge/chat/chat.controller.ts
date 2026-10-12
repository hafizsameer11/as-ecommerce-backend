import type { Ctx } from "@/core/http/router";
import { chatService as svc } from "./chat.service";
import type { AgentSendBody, MessagesQuery, SendBody, ThreadsQuery } from "./chat.schemas";

type Id = { id: string };

export const chatController = {
  // customer
  messages: ({ customerId, params, query }: Ctx<unknown, MessagesQuery, Id>) => svc.customerMessages(customerId, params.id, query),
  send: ({ customerId, params, body, files }: Ctx<SendBody, unknown, Id>) => svc.customerSend(customerId, params.id, body.text, files),
  unread: ({ customerId }: Ctx) => svc.customerUnread(customerId),

  // admin
  threads: ({ query, admin }: Ctx<unknown, ThreadsQuery>) => svc.threads(query, admin.id),
  adminMessages: ({ params, query }: Ctx<unknown, MessagesQuery, Id>) => svc.adminMessages(params.id, query),
  agentSend: async ({ params, body, files, admin, res }: Ctx<AgentSendBody, unknown, Id>) => {
    const m = await svc.agentSend(params.id, body, files, admin);
    res.locals.audit = { entityId: params.id, summary: `Concierge message on ${params.id}` };
    return m;
  },
  pin: ({ params, body }: Ctx<{ pinned: boolean }, unknown, Id>) => svc.pin(params.id, body.pinned),
};
