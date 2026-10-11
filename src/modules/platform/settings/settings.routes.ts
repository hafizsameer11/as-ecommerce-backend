import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { settingsController as c } from "./settings.controller";

export const settingsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/settings", tag: "Settings" })
  .get("/public", {
    summary: "Public store settings and business rules",
    description:
      "Everything the apps must NOT hard-code: delivery rates + free-shipping threshold, return window, tiers, concierge fees, " +
      "wallet limits, payment methods, locales/currencies, maintenance flag, status labels per screen.",
  }, c.publicSettings);

const code = z.object({ code: z.string().min(2).max(8) });
const groupParam = z.object({
  group: z.enum(["profile", "brand", "checkout", "shipping", "returns", "concierge", "wallet", "orders", "account", "legal", "maintenance", "app"]),
});

export const settingsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/settings", tag: "Settings", defaultAuth: "admin", defaultPermission: "settings.manage" })
  .get("/", { summary: "All settings groups" }, c.adminAll)
  .patch("/:group", {
    summary: "Update a settings group (partial)",
    params: groupParam,
    body: z.record(z.string(), z.unknown()),
    audit: { category: "settings", action: "settings.updated", severity: "notice" },
  }, c.updateGroup)
  .post("/payment-methods/:id/toggle", {
    summary: "Toggle payment method enabled / test mode",
    params: z.object({ id: z.string() }),
    body: z.object({ key: z.enum(["enabled", "testMode"]) }),
    audit: { category: "settings", action: "payment_method.toggled", severity: "notice" },
  }, c.togglePayment)
  .post("/locales/:code/toggle", { summary: "Enable/disable a language", params: code, audit: { category: "settings", action: "locale.toggled" } }, c.toggleLocale)
  .post("/locales/:code/default", { summary: "Set default language", params: code, audit: { category: "settings", action: "locale.default" } }, c.defaultLocale)
  .post("/currencies/:code/toggle", { summary: "Enable/disable a currency", params: code, audit: { category: "settings", action: "currency.toggled" } }, c.toggleCurrency)
  .post("/currencies/:code/default", { summary: "Set default currency", params: code, audit: { category: "settings", action: "currency.default" } }, c.defaultCurrency)
  .patch("/currencies/:code/rate", { summary: "Set FX rate (NGN per unit)", params: code, body: z.object({ rate: z.number().positive() }), audit: { category: "settings", action: "currency.rate" } }, c.setRate)
  .post("/fx/refresh", { summary: "Refresh FX rates" }, c.refreshFx);
