import { ModuleRouter } from "@/core/http/router";
import { appConfigController as c } from "./app-config.controller";
import { appConfigPatch, consentBody } from "./app-config.schemas";

/** asl-mobile splash / onboarding / force-update, asl-web cookie banner + "download our app" offer */
export const appConfigStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/app", tag: "App config" })
  .get("/config", {
    summary: "App configuration",
    description:
      "Onboarding slides, splash, home section toggles, feature flags, store URLs and versions. " +
      "Send `X-App-Version: 1.2.0` to get `updateRequired` (older than minSupportedVersion) and `updateAvailable` (older than latestVersion).",
  }, c.publicConfig)
  .post("/consent", {
    summary: "Save cookie consent choices",
    description: "Stored for compliance; linked to the customer when signed in.",
    auth: "optionalCustomer",
    body: consentBody,
    status: 201,
  }, c.consent)
  .post("/download-offer/claim", {
    summary: "Claim the app-download offer",
    description: "Signed-in customers only. Mints a personal single-use % code once per customer; claiming again returns the same code (`alreadyClaimed: true`).",
    auth: "customer",
  }, c.claimDownloadOffer);

export const appConfigAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/app", tag: "App config", defaultAuth: "admin", defaultPermission: "settings.manage" })
  .get("/config", { summary: "App configuration (settings group `app`)" }, c.adminConfig)
  .patch("/config", {
    summary: "Update app configuration",
    description: "Partial; features / homeSections / splash / downloadOffer are merged key by key.",
    body: appConfigPatch,
    audit: { category: "settings", action: "app_config.updated", entity: "settings", severity: "notice" },
  }, c.update);
