/**
 * Single source of truth for business rules that the UIs currently hard-code
 * (and disagree on). Every value is editable from admin → /settings and is served
 * to asl-web / asl-mobile via GET /store/settings/public.
 *
 * Resolved inconsistencies (see docs/DECISIONS.md):
 *  U1 delivery fees      → shipping zones + `shipping.freeShippingThreshold`
 *  U2 customer tiers     → Standard / Silver / Gold / Signature (ClubTier table)
 *  U3 return window      → `returns.windowDays`
 *  U4 concierge statuses → one enum + `labels.concierge` per screen
 *  U8 account deletion   → `account.deletionGraceDays` (self-service)
 *  U9 concierge fees     → `concierge.serviceFee`, `concierge.shippingEstimate`
 */
import { z } from "zod";

const money = z.number().int().min(0); // kobo

export const settingsSchemas = {
  profile: z.object({
    legalName: z.string(),
    displayName: z.string(),
    supportEmail: z.string().email(),
    supportPhone: z.string(),
    whatsapp: z.string(),
    address: z.string(),
    city: z.string(),
    country: z.string(),
    timezone: z.string(),
    currency: z.string().length(3),
    weightUnit: z.enum(["kg", "lb"]),
    logoUrl: z.string(),
    faviconUrl: z.string(),
    serviceHours: z.array(z.object({ days: z.string(), hours: z.string() })),
  }),
  brand: z.object({
    primary: z.string(), accent: z.string(), ink: z.string(), bg: z.string(),
    radius: z.number(), fontDisplay: z.string(), fontBody: z.string(),
  }),
  checkout: z.object({
    guestCheckout: z.boolean(),
    requirePhone: z.boolean(),
    askGiftMessage: z.boolean(),
    autoApplyBestCoupon: z.boolean(),
    minOrderValue: money,
    maxOrderValue: money,
    abandonMinutes: z.number().int().min(5),
    unpaidOrderMinutes: z.number().int().min(5),
    taxesIncluded: z.boolean(),
  }),
  shipping: z.object({
    freeShippingThreshold: money,
    processingTime: z.string(),
    importantNote: z.string(),
  }),
  returns: z.object({
    windowDays: z.number().int().min(0).max(90),
    refundProcessingDays: z.string(),
    nonReturnableCategories: z.array(z.string()),
    damagedReportHours: z.number().int(),
    returnShippingPaidBy: z.enum(["customer", "store"]),
    exchangesOnlyForDefective: z.boolean(),
  }),
  concierge: z.object({
    serviceFee: money,
    shippingEstimate: money,
    defaultDepositPct: z.number().int().min(0).max(100),
    quoteValidityHours: z.number().int().min(1),
    responseSlaHours: z.object({ standard: z.number(), priority: z.number(), vip: z.number() }),
  }),
  wallet: z.object({
    minTopup: money,
    maxTopup: money,
    minWithdrawal: money,
    autoApproveWithdrawalBelow: money,
  }),
  orders: z.object({
    highValueThreshold: money,
    cancelBeforeStatus: z.enum(["paid", "processing", "shipped"]),
  }),
  account: z.object({
    deletionGraceDays: z.number().int().min(0),
    passwordMinLength: z.number().int().min(6),
  }),
  tax: z.object({
    displayPricesIncTax: z.boolean(),
    chargeTaxOnShipping: z.boolean(),
    chargeTaxOnConcierge: z.boolean(),
    registeredTIN: z.string(),
    companyLegalName: z.string(),
    invoicePrefix: z.string(),
    fiscalYearStartMonth: z.number().int().min(1).max(12),
    autoRounding: z.enum(["line", "subtotal"]),
  }),
  legal: z.object({
    vatNumber: z.string(), rcNumber: z.string(),
  }),
  maintenance: z.object({ enabled: z.boolean(), message: z.string() }),
  app: z.object({
    minSupportedVersion: z.string(),
    latestVersion: z.string(),
    iosStoreUrl: z.string(),
    androidStoreUrl: z.string(),
    onboarding: z.array(z.object({ title: z.string(), body: z.string(), image: z.string().optional() })),
    features: z.record(z.string(), z.boolean()),
  }),
} as const;

export type SettingsGroup = keyof typeof settingsSchemas;
export type SettingsOf<G extends SettingsGroup> = z.infer<(typeof settingsSchemas)[G]>;

const N = (naira: number) => naira * 100;

export const settingsDefaults: { [G in SettingsGroup]: SettingsOf<G> } = {
  profile: {
    legalName: "ASL Originals Ltd",
    displayName: "ASL ORIGINALS",
    supportEmail: "customerservice@asloriginals.com",
    supportPhone: "+234 810 123 4567",
    whatsapp: "+234 810 123 4567",
    address: "Lekki Phase 1, Lagos, Nigeria",
    city: "Lagos",
    country: "NG",
    timezone: "Africa/Lagos",
    currency: "NGN",
    weightUnit: "kg",
    logoUrl: "",
    faviconUrl: "",
    serviceHours: [
      { days: "Monday - Saturday", hours: "9:00 AM - 8:00 PM WAT" },
      { days: "Sunday", hours: "9:00 AM - 8:00 PM WAT" },
    ],
  },
  brand: { primary: "#cc5000", accent: "#cc5000", ink: "#0f0f0f", bg: "#faf8f3", radius: 4, fontDisplay: "Inter Tight", fontBody: "Inter Tight" },
  checkout: {
    guestCheckout: false,
    requirePhone: true,
    askGiftMessage: false,
    autoApplyBestCoupon: false,
    minOrderValue: 0,
    maxOrderValue: N(50_000_000),
    abandonMinutes: 60,
    unpaidOrderMinutes: 30,
    taxesIncluded: true,
  },
  shipping: {
    // U1: one threshold everywhere (announcement bar + help article value)
    freeShippingThreshold: N(150_000),
    processingTime: "All orders are processed within 24 - 48 hours (excluding weekends and public holidays).",
    importantNote:
      "Please ensure your delivery details are accurate to avoid delays. ASL ORIGINALS is not responsible for orders delayed due to incorrect or incomplete addresses provided by the customer.",
  },
  returns: {
    // U3: one return window everywhere (return-policy page value)
    windowDays: 7,
    refundProcessingDays: "5 - 10 working days",
    nonReturnableCategories: ["fragrances", "underwear", "swimwear", "personal-care"],
    damagedReportHours: 48,
    returnShippingPaidBy: "customer",
    exchangesOnlyForDefective: true,
  },
  concierge: {
    serviceFee: N(50_500),
    shippingEstimate: N(35_000),
    defaultDepositPct: 100,
    quoteValidityHours: 72,
    responseSlaHours: { standard: 48, priority: 24, vip: 12 },
  },
  wallet: { minTopup: N(500), maxTopup: N(5_000_000), minWithdrawal: N(1_000), autoApproveWithdrawalBelow: N(0) },
  orders: { highValueThreshold: N(2_000_000), cancelBeforeStatus: "shipped" },
  account: { deletionGraceDays: 30, passwordMinLength: 8 },
  tax: {
    displayPricesIncTax: true,
    chargeTaxOnShipping: true,
    chargeTaxOnConcierge: false,
    registeredTIN: "",
    companyLegalName: "ASL Originals Ltd",
    invoicePrefix: "INV-",
    fiscalYearStartMonth: 1,
    autoRounding: "subtotal",
  },
  legal: { vatNumber: "", rcNumber: "" },
  maintenance: { enabled: false, message: "We're making improvements and will be back shortly." },
  app: {
    minSupportedVersion: "1.0.0",
    latestVersion: "1.0.0",
    iosStoreUrl: "",
    androidStoreUrl: "",
    onboarding: [
      { title: "Authentic luxury", body: "Every piece is sourced from trusted retailers and verified." },
      { title: "Fashion concierge", body: "Can't find it? Tell us what you want and we'll source it." },
      { title: "ASL Club", body: "Earn points on every order and unlock member rewards." },
    ],
    features: { concierge: true, drops: true, wallet: true, referrals: true },
  },
};

/** Groups readable by anyone (no secrets in here). */
export const PUBLIC_GROUPS: SettingsGroup[] = [
  "profile", "brand", "checkout", "shipping", "returns", "concierge", "wallet", "account", "tax", "maintenance", "app",
];
