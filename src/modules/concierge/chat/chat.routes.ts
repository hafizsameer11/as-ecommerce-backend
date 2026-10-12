import { ModuleRouter, idParam } from "@/core/http/router";
import { chatController as c } from "./chat.controller";
import { agentSendBody, messagesQuery, pinBody, sendBody, threadsQuery } from "./chat.schemas";

const files = { field: "attachments", maxCount: 5, maxMB: 10, accept: /^(image\/(jpeg|png|webp|gif|heic|heif|avif)|application\/pdf)$/ };

/** request chat in the apps (REST; new messages + typing also arrive on the socket, see core/realtime/realtime.ts) */
export const conciergeChatStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/concierge", tag: "Concierge chat", defaultAuth: "customer" })
  .get("/unread", { summary: "Unread concierge messages (badge)" }, c.unread)
  .get("/requests/:id/messages", { summary: "Messages, oldest first (marks agent + system messages read). Older pages: `before`", params: idParam, query: messagesQuery }, c.messages)
  .post("/requests/:id/messages", { summary: "Send a message (multipart: `text` + up to 5 `attachments`, images / PDF)", params: idParam, upload: files, body: sendBody, status: 201 }, c.send);

/** asl-admin /concierge/chat — `:id` is the request id or ASL number */
export const conciergeChatAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/concierge/threads", tag: "Concierge chat", defaultAuth: "admin", defaultPermission: "concierge.view" })
  .get("/", { summary: "Threads (all / unread / pinned / VIP, search) + total unread", query: threadsQuery }, c.threads)
  .get("/:id/messages", { summary: "Messages (marks the customer's messages read)", params: idParam, query: messagesQuery }, c.adminMessages)
  .post("/:id/messages", {
    summary: "Send as agent (multipart: `text`, optional `quoteId` card, `channel`, up to 5 `attachments`)",
    params: idParam, upload: files, body: agentSendBody, status: 201,
    audit: { category: "concierge", action: "concierge.message_sent", entity: "concierge_request" },
  }, c.agentSend)
  .post("/:id/pin", { summary: "Pin / unpin", params: idParam, body: pinBody }, c.pin);
