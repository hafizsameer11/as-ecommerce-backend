import { ModuleRouter, idParam } from "@/core/http/router";
import { canMerchandise as access, MERCH_ACCESS_NOTE as description } from "../impressions/placements";
import { announcementsController as c } from "./announcements.controller";
import { announcementBody, announcementListQuery, announcementPatch, announcementStatusBody, storeAnnouncementsQuery } from "./announcements.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "announcement" });
const m = { description, middleware: [access] };

/** Storefront announcement bar: audience everyone / guests / members / club_gold (Gold+) / club_signature from the caller. */
export const announcementsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/announcements", tag: "Merchandising", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Live announcements for the caller, highest priority first ({{freeShippingThreshold}} filled in)", query: storeAnnouncementsQuery }, c.storeList);

/** asl-admin /announcement */
export const announcementsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/announcements", tag: "Announcements", defaultAuth: "admin" })
  .get("/admin-bar", { summary: "Live admin_top notices for the admin app's bar (any signed-in staff)" }, c.adminBar)
  .get("/", { ...m, summary: "Announcements (filter by placement / status tab; tabs, KPIs, showingNow)", query: announcementListQuery }, c.list)
  .get("/:id", { ...m, summary: "Announcement", params: idParam }, c.get)
  .post("/", { ...m, summary: "Create announcement (paused unless a status is given)", body: announcementBody, status: 201, audit: audit("announcement.created") }, c.create)
  .patch("/:id", { ...m, summary: "Update announcement", params: idParam, body: announcementPatch, audit: audit("announcement.updated") }, c.update)
  .patch("/:id/status", { ...m, summary: "Change status (live with a future start → scheduled)", params: idParam, body: announcementStatusBody, audit: audit("announcement.status_changed") }, c.setStatus)
  .post("/:id/duplicate", { ...m, summary: "Duplicate (paused)", params: idParam, status: 201, audit: audit("announcement.duplicated") }, c.duplicate)
  .delete("/:id", { ...m, summary: "Delete announcement", params: idParam, audit: audit("announcement.deleted") }, c.remove);
