import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

/** multipart: `text` + up to 5 `attachments` (images / PDF) */
export const sendBody = z.object({
  text: z.string().trim().max(4000).default(""),
});
export const agentSendBody = sendBody.extend({
  /** attach a quote card (must belong to this request) */
  quoteId: z.string().max(64).optional(),
  /** where the agent replied (inbound WhatsApp / SMS / e-mail adapters are later work) */
  channel: z.enum(["app", "email", "whatsapp", "sms"]).default("app"),
});
export const messagesQuery = z.object({
  /** ISO date: only messages before this (older pages) */
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const threadsQuery = pageQuery.extend({
  filter: z.enum(["all", "unread", "pinned", "vip"]).default("all"),
  assignee: z.string().max(64).optional(),
});
export const pinBody = z.object({ pinned: z.boolean() });

export type SendBody = z.infer<typeof sendBody>;
export type AgentSendBody = z.infer<typeof agentSendBody>;
export type MessagesQuery = z.infer<typeof messagesQuery>;
export type ThreadsQuery = z.infer<typeof threadsQuery>;
