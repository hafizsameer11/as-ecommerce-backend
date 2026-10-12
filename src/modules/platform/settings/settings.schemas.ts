import { z } from "zod";

export const settingsGroupParam = z.object({
  group: z.enum(["profile", "brand", "checkout", "shipping", "returns", "concierge", "wallet", "orders", "account", "tax", "finance", "legal", "maintenance", "app", "drops", "support"]),
});
export const settingsGroupPatch = z.record(z.string(), z.unknown());
export const codeParam = z.object({ code: z.string().min(2).max(8) });
export const paymentMethodIdParam = z.object({ id: z.string() });
export const paymentToggleBody = z.object({ key: z.enum(["enabled", "testMode"]) });
export const rateBody = z.object({ rate: z.number().positive() });

export type SettingsGroupPatch = z.infer<typeof settingsGroupPatch>;
export type CodeParam = z.infer<typeof codeParam>;
export type PaymentToggleBody = z.infer<typeof paymentToggleBody>;
export type RateBody = z.infer<typeof rateBody>;
