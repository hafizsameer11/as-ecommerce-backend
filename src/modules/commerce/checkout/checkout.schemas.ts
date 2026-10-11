import { z } from "zod";

export const contactSchema = z.object({
  email: z.string().trim().email().max(190),
  phone: z.string().trim().max(30).default(""),
  subscribe: z.boolean().default(false),
});

/** the apps' CheckoutAddress */
export const addressSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  address: z.string().trim().min(3).max(190),
  apartment: z.string().trim().max(190).default(""),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(80),
  postal: z.string().trim().max(20).default(""),
  country: z.string().trim().min(2).max(56).default("Nigeria"),
  phone: z.string().trim().max(30).optional(),
});

/** UI sends "bank" for bank transfer */
const paymentMethod = z
  .enum(["card", "paystack", "bank", "bank_transfer", "wallet"])
  .transform((m) => (m === "bank" ? "bank_transfer" : m) as "card" | "paystack" | "bank_transfer" | "wallet");

export const updateCheckoutBody = z.object({
  contact: contactSchema.optional(),
  delivery: z.enum(["ship", "pickup"]).optional(),
  address: addressSchema.nullable().optional(),
  /** use one of my saved addresses instead of typing it */
  savedAddressId: z.string().max(64).optional(),
  pickupLocationId: z.string().max(64).nullable().optional(),
  shippingRateId: z.string().max(64).nullable().optional(),
  paymentMethod: paymentMethod.optional(),
  useWallet: z.boolean().optional(),
  giftMessage: z.string().trim().max(500).nullable().optional(),
});

export const couponBody = z.object({ code: z.string().trim().min(1).max(40) });

export const placeOrderBody = z.object({
  /** where the payment page sends the customer back (your site or the app scheme) */
  returnUrl: z.string().url().max(500).nullable().optional(),
  savedMethodId: z.string().max(64).nullable().optional(),
  saveCard: z.boolean().default(false),
  /** totals the customer saw; if the server total differs the order is refused so they can review */
  expectedTotal: z.number().int().min(0).optional(),
});

export type UpdateCheckoutBody = z.infer<typeof updateCheckoutBody>;
export type PlaceOrderBody = z.infer<typeof placeOrderBody>;
export type CheckoutAddress = z.infer<typeof addressSchema>;
export type CheckoutContact = z.infer<typeof contactSchema>;
