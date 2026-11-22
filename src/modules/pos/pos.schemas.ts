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

export const paymentLine = z.object({
  method: z.enum(["cash", "card", "transfer", "wallet", "points", "giftcard"]),
  amount: z.number().int().positive(),
  /** gift card code when method = giftcard; transfer/card ref otherwise */
  reference: z.string().trim().max(120).optional(),
});

export const saleExtra = z.object({
  kind: z.enum(["giftcard", "alteration", "delivery"]),
  label: z.string().trim().min(1).max(120),
  amount: money,
  ref: z.string().trim().max(64).optional(),
});

export const shipAddress = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30),
  address: z.string().trim().min(1).max(300),
  apartment: z.string().trim().max(120).optional(),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  postal: z.string().trim().max(20).optional(),
  country: z.string().trim().max(2).default("NG"),
});

export const quoteBody = z.object({
  lines: z.array(quoteLine).min(1).max(100),
  customerId: id.optional(),
  couponCode: z.string().trim().toUpperCase().max(40).optional(),
  manual: lineDisc,
  pointsToUse: z.number().int().min(0).default(0),
  fulfilment: z.enum(["instore", "ship", "layaway"]).default("instore"),
  shippingAddress: shipAddress.optional(),
  shippingRateId: id.optional(),
  extras: z.array(saleExtra).max(20).optional(),
  deposit: money.optional(),
  locationId: id.optional(),
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

export const giftCardsQuery = pageQuery.extend({
  q: z.string().trim().max(64).optional(),
  status: z.enum(["active", "used", "cancelled"]).optional(),
});

export const issueGiftCardBody = z.object({
  amount: z.number().int().positive(),
  code: z.string().trim().toUpperCase().min(6).max(32).optional(),
  customerId: id.optional(),
  locationId: id.optional(),
  orderId: id.optional(),
  expiryMonths: z.number().int().min(1).max(60).optional(),
});

export const adjustGiftCardBody = z.object({
  amount: z.number().int(),
  note: z.string().trim().max(200).optional(),
  cancel: z.boolean().default(false),
});

export const createAlterationBody = z.object({
  customerId: id.optional(),
  customerName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(7).max(30),
  orderNumber: z.string().trim().max(40).optional(),
  item: z.string().trim().min(1).max(190),
  work: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
  notes: z.string().trim().max(2000).optional(),
  fee: money.default(0),
  locationId: id,
  tailor: z.string().trim().min(1).max(120),
  readyBy: z.string().datetime(),
});

export const alterationStatusBody = z.object({
  status: z.enum(["received", "with-tailor", "ready", "collected"]),
});

export const createTransferBody = z.object({
  fromWarehouseId: id,
  toWarehouseId: id,
  variantId: id,
  qty: z.number().int().min(1).max(500),
  reason: z.string().trim().max(300).optional(),
});

export const transferStepBody = z.object({
  status: z.enum(["approved", "in-transit", "received", "rejected"]),
  note: z.string().trim().max(300).optional(),
});

export const createStockCountBody = z.object({
  warehouseId: id,
  scope: z.string().trim().min(1).max(120),
  lines: z
    .array(
      z.object({
        variantId: id,
        expected: z.number().int().min(0),
        counted: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});

export const createGrnBody = z.object({
  supplier: z.string().trim().min(1).max(120),
  warehouseId: id,
  expectedAt: z.string().datetime(),
  lines: z
    .array(
      z.object({
        variantId: id,
        qty: z.number().int().min(1).max(5000),
        received: z.number().int().min(0).max(5000).default(0),
      }),
    )
    .min(1)
    .max(500),
});

export const receiveGrnBody = z.object({
  lines: z
    .array(
      z.object({
        variantId: id,
        received: z.number().int().min(0).max(5000),
      }),
    )
    .min(1)
    .max(500),
});

export const settleLayawayBody = z.object({
  payments: z.array(paymentLine).min(1).max(10),
  change: money.default(0),
  registerSessionId: id.optional(),
});

export const createConciergeBody = z.object({
  customerId: id.optional(),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: z.string().trim().toLowerCase().email().max(190).optional(),
  contactPhone: z.string().trim().max(30).optional(),
  itemName: z.string().trim().min(1).max(190),
  category: z.string().trim().min(1).max(60),
  brand: z.string().trim().max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  size: z.string().trim().max(40).optional(),
  color: z.string().trim().max(60).optional(),
  budget: money.optional(),
  notes: z.string().trim().max(4000).optional(),
  qty: z.number().int().min(1).max(20).default(1),
  locationId: id,
});

export const shippingQuoteBody = z.object({
  address: shipAddress,
  subtotal: money,
  weightKg: z.number().min(0.01).max(100).optional(),
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
export type GiftCardsQuery = z.infer<typeof giftCardsQuery>;
export type IssueGiftCardBody = z.infer<typeof issueGiftCardBody>;
export type AdjustGiftCardBody = z.infer<typeof adjustGiftCardBody>;
export type CreateAlterationBody = z.infer<typeof createAlterationBody>;
export type AlterationStatusBody = z.infer<typeof alterationStatusBody>;
export type CreateTransferBody = z.infer<typeof createTransferBody>;
export type TransferStepBody = z.infer<typeof transferStepBody>;
export type CreateStockCountBody = z.infer<typeof createStockCountBody>;
export type CreateGrnBody = z.infer<typeof createGrnBody>;
export type ReceiveGrnBody = z.infer<typeof receiveGrnBody>;
export type SettleLayawayBody = z.infer<typeof settleLayawayBody>;
export type CreateConciergeBody = z.infer<typeof createConciergeBody>;
export type ShippingQuoteBody = z.infer<typeof shippingQuoteBody>;
