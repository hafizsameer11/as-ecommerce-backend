import { ModuleRouter, idParam } from "@/core/http/router";
import { campaignsController as c } from "./campaigns.controller";
import { campaignBody, campaignListQuery, campaignPatch, campaignStatusBody, clickQuery, sendTestBody, tokenParam } from "./campaigns.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "campaign" });

/** asl-admin /campaigns */
export const campaignsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/campaigns", tag: "Campaigns", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/", { summary: "Campaigns (tabs by status, channel filter, KPIs; conversions = paid orders ≤ 7 days after a click)", query: campaignListQuery }, c.list)
  .get("/:id", { summary: "Campaign with stats", params: idParam }, c.get)
  .get("/:id/audience", { summary: "How many customers would receive it now", params: idParam }, c.audience)
  .post("/", { summary: "Create campaign (draft)", body: campaignBody, status: 201, audit: audit("campaign.created") }, c.create)
  .patch("/:id", { summary: "Edit a draft / scheduled / paused campaign", params: idParam, body: campaignPatch, audit: audit("campaign.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate as draft", params: idParam, status: 201, audit: audit("campaign.duplicated") }, c.duplicate)
  .post("/:id/pin", { summary: "Pin / unpin", params: idParam }, c.togglePin)
  .patch("/:id/status", { summary: "schedule · unschedule · pause · resume · archive · unarchive", params: idParam, body: campaignStatusBody, audit: audit("campaign.status_changed") }, c.setStatus)
  .post("/:id/send-test", { summary: "Send a test (email to you / SMS to `to` / push to a test device / in-app to `customerId`)", params: idParam, body: sendTestBody }, c.sendTest)
  .post("/:id/send-now", { summary: "Send now (audience built from the segment, batches in the background)", params: idParam, audit: audit("campaign.sent") }, c.sendNow)
  .delete("/:id", { summary: "Delete campaign", params: idParam, audit: audit("campaign.deleted") }, c.remove);

/** email open pixel + click redirect (only to the storefront / API hosts) */
export const campaignTrackingRoutes = new ModuleRouter({ surface: "public", prefix: "/t", tag: "Campaign tracking" })
  .get("/o/:token", { summary: "Open pixel (1×1 GIF)", params: tokenParam }, c.open)
  .get("/c/:token", { summary: "Click redirect (`u` must be a path or a URL on the storefront host)", params: tokenParam, query: clickQuery }, c.click);

/** unsubscribe link in campaign emails / SMS (POST for one-click List-Unsubscribe) */
export const unsubscribeRoutes = new ModuleRouter({ surface: "public", prefix: "/unsubscribe", tag: "Campaign tracking" })
  .get("/:token", { summary: "Unsubscribe confirm page (HTML) — link scanners can't unsubscribe by opening it", params: tokenParam }, c.confirmUnsubscribe)
  .post("/:token", { summary: "One-click unsubscribe", params: tokenParam }, c.unsubscribe);
