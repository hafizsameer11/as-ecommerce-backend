import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const statuses = ["new", "sourcing", "quoted", "approved", "payment_pending", "ordered", "in_transit", "delivered", "cancelled", "unavailable"] as const;
export const conciergeStatus = z.enum(statuses);
export const conciergePriority = z.enum(["standard", "priority", "vip"]);

const text = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

/**
 * /start-request form (multipart: these fields + up to 6 `images`) or a concierge-shop item
 * (`source: "catalog"`, `productId` = product id or handle, plus size / colour).
 * Guests must give contactName + contactEmail; signed-in customers' details come from the account.
 */
export const createRequestBody = z
  .object({
    source: z.enum(["form", "catalog"]).default("form"),
    productId: text(64),
    itemName: text(190),
    category: text(60),
    brand: text(120),
    reference: text(1024),
    description: text(4000),
    size: text(40),
    color: text(60),
    condition: text(40),
    /** kobo */
    budget: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
    preferredSource: text(80),
    notes: text(4000),
    qty: z.coerce.number().int().min(1).max(20).default(1),
    contactName: text(120),
    contactEmail: z.string().trim().toLowerCase().email().max(190).optional(),
    contactPhone: text(30),
  })
  .superRefine((b, ctx) => {
    if (b.source === "catalog" && !b.productId) ctx.addIssue({ code: "custom", path: ["productId"], message: "Choose the item you want us to source." });
    if (b.source === "form") {
      if (!b.itemName) ctx.addIssue({ code: "custom", path: ["itemName"], message: "Tell us the product name / brand." });
      if (!b.category) ctx.addIssue({ code: "custom", path: ["category"], message: "Choose a category." });
    }
  });

export const myRequestsQuery = pageQuery.extend({ tab: z.enum(["all", "progress", "completed", "cancelled"]).default("all") });
export const cancelBody = z.object({ reason: z.string().trim().max(500).optional() });
export const trackQuery = z.object({ email: z.string().trim().toLowerCase().email().max(190).optional() });
export const numberParam = z.object({ number: z.string().trim().min(3).max(32) });

export const adminTabs = ["all", "open", "unassigned", "sla_breached", "sla_at_risk", "vip", ...statuses] as const;
export const adminRequestsQuery = pageQuery.extend({
  tab: z.enum(adminTabs).default("all"),
  priority: conciergePriority.optional(),
  /** admin id, `me` or `unassigned` */
  assignee: z.string().max(64).optional(),
  supplierId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  /** sla | -createdAt | createdAt | -updatedAt */
  sort: z.enum(["sla", "createdAt", "-createdAt", "-updatedAt"]).default("-createdAt"),
});

export const statusBody = z.object({ status: conciergeStatus, note: z.string().trim().max(1000).optional() });
export const assignBody = z.object({ adminId: z.string().min(1).max(64).nullable() });
export const priorityBody = z.object({ priority: conciergePriority });
export const supplierLinkBody = z.object({ supplierId: z.string().min(1).max(64).nullable() });
export const noteBody = z.object({ text: z.string().trim().min(1).max(4000), internal: z.boolean().default(true) });

export type CreateRequestBody = z.infer<typeof createRequestBody>;
export type MyRequestsQuery = z.infer<typeof myRequestsQuery>;
export type AdminRequestsQuery = z.infer<typeof adminRequestsQuery>;
export type StatusBody = z.infer<typeof statusBody>;
export type NoteBody = z.infer<typeof noteBody>;
