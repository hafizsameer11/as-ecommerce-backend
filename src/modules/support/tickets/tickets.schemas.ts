import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

export const TICKET_STATUSES = ["open", "pending", "on_hold", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_CHANNELS = ["email", "chat", "whatsapp", "instagram", "phone", "web", "app"] as const;
export const TICKET_CATEGORIES = ["order", "delivery", "returns", "payment", "product", "concierge", "account", "other"] as const;

const message = z.string().trim().min(5, "Please tell us a little more (at least 5 characters).").max(5000);
const orderRef = z.string().trim().max(40).optional();

/** /account/help/contact (signed in): topic chip + message (multipart: up to 5 `attachments`) */
export const createTicketBody = z.object({
  topic: z.string().trim().min(2, "Please choose what we can help with.").max(120),
  message,
  /** the topic chip's category; when missing it is guessed from the topic */
  category: z.enum(TICKET_CATEGORIES).optional(),
  orderRef,
  /** where the form was sent from */
  channel: z.enum(["web", "app"]).default("web"),
});

/** /customer-care/contact-us (guest) */
export const contactBody = z.object({
  name: z.string().trim().min(2, "Please enter your name.").max(120),
  email: z.email("Enter a valid email address.").trim().toLowerCase().max(190),
  subject: z.string().trim().min(2, "Please select a subject.").max(120),
  message,
  phone: z.string().trim().max(40).optional(),
  orderRef,
});

export const myTicketsQuery = pageQuery.extend({
  /** open = open / pending / on hold · closed = resolved / closed */
  tab: z.enum(["all", "open", "closed"]).default("all"),
});

export const customerMessageBody = z.object({ body: z.string().trim().min(1).max(5000) });

export const adminTicketsQuery = pageQuery.extend({
  tab: z.enum(["all", ...TICKET_STATUSES, "unassigned", "mine", "breached"]).default("all"),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  channel: z.enum(TICKET_CHANNELS).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  /** admin id, `me` or `none` */
  assignee: z.string().max(64).optional(),
  tag: z.string().max(40).optional(),
});

export const replyBody = z.object({
  body: z.string().trim().min(1).max(10_000),
  /** internal note: never shown to the customer, doesn't count as a response */
  internal: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).default(false),
});
export const statusBody = z.object({ status: z.enum(TICKET_STATUSES) });
export const priorityBody = z.object({ priority: z.enum(TICKET_PRIORITIES) });
/** PATCH /tickets/:id — status and/or priority */
export const ticketPatch = z.object({ status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), category: z.enum(TICKET_CATEGORIES).optional() })
  .refine((v) => v.status || v.priority || v.category, { message: "Nothing to change" });
export const assignBody = z.object({ adminId: z.string().max(64).nullable() });
export const tagBody = z.object({ tag: z.string().trim().toLowerCase().min(1).max(40) });
export const tagParam = z.object({ id: z.string(), tag: z.string().min(1).max(40) });

export type CreateTicketBody = z.infer<typeof createTicketBody>;
export type ContactBody = z.infer<typeof contactBody>;
export type MyTicketsQuery = z.infer<typeof myTicketsQuery>;
export type CustomerMessageBody = z.infer<typeof customerMessageBody>;
export type AdminTicketsQuery = z.infer<typeof adminTicketsQuery>;
export type ReplyBody = z.infer<typeof replyBody>;
export type StatusBody = z.infer<typeof statusBody>;
export type PriorityBody = z.infer<typeof priorityBody>;
export type TicketPatch = z.infer<typeof ticketPatch>;
export type AssignBody = z.infer<typeof assignBody>;
export type TagBody = z.infer<typeof tagBody>;
