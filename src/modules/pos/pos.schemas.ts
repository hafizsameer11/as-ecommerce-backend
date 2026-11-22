import { z } from "zod";
import { pageQuery } from "@/core/http/pagination";

const pin = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");
const money = z.number().int().min(0);
const id = z.string().min(1).max(64);

export const pinLoginBody = z.object({
  pin,
  registerId: id.optional(),
});

export const openSessionBody = z.object({
  float: money.optional(),
});

export const cashMoveBody = z.object({
  type: z.enum(["in", "out"]),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(1).max(200),
});

export const closeSessionBody = z.object({
  counted: money,
  note: z.string().trim().max(500).optional(),
});

export const catalogQuery = pageQuery.extend({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(64).optional(),
  sku: z.string().trim().max(64).optional(),
});

export const customersQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(120),
});

export const createCustomerBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().toLowerCase().email().max(190).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
});

const lineDisc = z
  .object({
    type: z.enum(["percent", "amount"]),
    value: z.number().min(0),
    max: z.number().int().min(0).optional(),
  })
  .optional();

export const quoteLine = z.object({
  variantId: id,
  qty: z.number().int().min(1).max(50),
  unitPrice: money.optional(),
  discount: lineDisc,
  soldById: id.optional(),
});

export const quoteBody = z.object({
  lines: z.array(quoteLine).min(1).max(100),
  customerId: id.optional(),
  couponCode: z.string().trim().toUpperCase().max(40).optional(),
  manual: lineDisc,
  pointsToUse: z.number().int().min(0).default(0),
});

export const paymentLine = z.object({
  method: z.enum(["cash", "card", "transfer", "wallet", "points"]),
  amount: z.number().int().positive(),
  reference: z.string().trim().max(120).optional(),
});

export const completeSaleBody = quoteBody.extend({
  registerSessionId: id,
  payments: z.array(paymentLine).min(1).max(10),
  change: money.default(0),
  note: z.string().trim().max(1000).optional(),
  /** offline sync idempotency */
  clientKey: z.string().trim().min(8).max(64).optional(),
  approvedById: id.optional(),
});

export const syncSalesBody = z.object({
  sales: z.array(completeSaleBody).min(1).max(50),
});

export const posReturnLine = z.object({
  orderItemId: id,
  qty: z.number().int().min(1).max(50),
});

export const posReturnBody = z.object({
  lines: z.array(posReturnLine).min(1).max(50),
  reason: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
  refundTo: z.enum(["original", "wallet", "cash"]).default("original"),
  amount: money.optional(),
  restock: z.boolean().default(true),
  override: z.boolean().default(false),
  approvedById: id.optional(),
  registerSessionId: id.optional(),
  registerId: id.optional(),
  locationId: id.optional(),
  warehouseId: id.optional(),
});

export const pickupsQuery = pageQuery.extend({
  locationId: id.optional(),
  status: z.enum(["scheduled", "ready", "collected", "no_show", "cancelled"]).optional(),
  q: z.string().trim().max(80).optional(),
});

export const collectPickupBody = z.object({
  code: z.string().trim().min(4).max(8).optional(),
  idChecked: z.boolean().default(false),
  collectedBy: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
  offline: z.boolean().default(false),
});

export const sendReceiptBody = z.object({
  channel: z.enum(["email", "sms", "whatsapp"]),
  gift: z.boolean().default(false),
  to: z.string().trim().max(190).optional(),
});

export type PinLoginBody = z.infer<typeof pinLoginBody>;
export type OpenSessionBody = z.infer<typeof openSessionBody>;
export type CashMoveBody = z.infer<typeof cashMoveBody>;
export type CloseSessionBody = z.infer<typeof closeSessionBody>;
export type CatalogQuery = z.infer<typeof catalogQuery>;
export type CustomersQuery = z.infer<typeof customersQuery>;
export type CreateCustomerBody = z.infer<typeof createCustomerBody>;
export type QuoteBody = z.infer<typeof quoteBody>;
export type CompleteSaleBody = z.infer<typeof completeSaleBody>;
export type SyncSalesBody = z.infer<typeof syncSalesBody>;
export type PosReturnBody = z.infer<typeof posReturnBody>;
export type PickupsQuery = z.infer<typeof pickupsQuery>;
export type CollectPickupBody = z.infer<typeof collectPickupBody>;
export type SendReceiptBody = z.infer<typeof sendReceiptBody>;
