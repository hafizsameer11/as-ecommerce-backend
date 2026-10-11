import { ModuleRouter } from "@/core/http/router";
import { settingsController as c } from "./settings.controller";
import { codeParam, paymentMethodIdParam, paymentToggleBody, rateBody, settingsGroupParam, settingsGroupPatch } from "./settings.schemas";

export const settingsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/settings", tag: "Settings" })
  .get("/public", {
    summary: "Public store settings and business rules",
    description:
      "Everything the apps must NOT hard-code: delivery rates + free-shipping threshold, return window, tiers, concierge fees, " +
      "wallet limits, payment methods, locales/currencies, maintenance flag, status labels per screen.",
  }, c.publicSettings);

export const settingsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/settings", tag: "Settings", defaultAuth: "admin", defaultPermission: "settings.manage" })
  .get("/", { summary: "All settings groups" }, c.adminAll)
  .patch("/:group", {
    summary: "Update a settings group (partial)",
    params: settingsGroupParam,
    body: settingsGroupPatch,
    audit: { category: "settings", action: "settings.updated", severity: "notice" },
  }, c.updateGroup)
  .post("/payment-methods/:id/toggle", {
    summary: "Toggle payment method enabled / test mode",
    params: paymentMethodIdParam,
    body: paymentToggleBody,
    audit: { category: "settings", action: "payment_method.toggled", severity: "notice" },
  }, c.togglePayment)
  .post("/locales/:code/toggle", { summary: "Enable/disable a language", params: codeParam, audit: { category: "settings", action: "locale.toggled" } }, c.toggleLocale)
  .post("/locales/:code/default", { summary: "Set default language", params: codeParam, audit: { category: "settings", action: "locale.default" } }, c.defaultLocale)
  .post("/currencies/:code/toggle", { summary: "Enable/disable a currency", params: codeParam, audit: { category: "settings", action: "currency.toggled" } }, c.toggleCurrency)
  .post("/currencies/:code/default", { summary: "Set default currency", params: codeParam, audit: { category: "settings", action: "currency.default" } }, c.defaultCurrency)
  .patch("/currencies/:code/rate", { summary: "Set FX rate (NGN per unit)", params: codeParam, body: rateBody, audit: { category: "settings", action: "currency.rate" } }, c.setRate)
  .post("/fx/refresh", { summary: "Refresh FX rates" }, c.refreshFx);
