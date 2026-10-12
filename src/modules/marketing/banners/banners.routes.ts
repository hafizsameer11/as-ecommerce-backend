import { ModuleRouter, idParam } from "@/core/http/router";
import { canMerchandise as access, MERCH_ACCESS_NOTE as description } from "../impressions/placements";
import { bannersController as c } from "./banners.controller";
import { bannerBody, bannerListQuery, bannerPatch, bannerReorderBody, bannerStatusBody, moveBody, storeBannersQuery } from "./banners.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "banner" });
const m = { description, middleware: [access] };

/** Storefront strips: live + inside the schedule, filtered by the caller's audience (guest / member / vip = Gold+). */
export const bannersStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/banners", tag: "Merchandising", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Live banners for a placement (priority 1 first; {{freeShippingThreshold}} filled in)", query: storeBannersQuery }, c.storeList);

/** asl-admin /banners */
export const bannersAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/banners", tag: "Banners", defaultAuth: "admin" })
  .get("/", { ...m, summary: "Banners (filter by placement / status tab; tabs, per-placement counts, KPIs incl. CTR)", query: bannerListQuery }, c.list)
  .post("/reorder", { ...m, summary: "Reorder a placement (ids in display order → priority 1..n)", body: bannerReorderBody, audit: audit("banner.reordered") }, c.reorder)
  .get("/:id", { ...m, summary: "Banner", params: idParam }, c.get)
  .post("/", { ...m, summary: "Create banner (live with a future start → scheduled)", body: bannerBody, status: 201, audit: audit("banner.created") }, c.create)
  .patch("/:id", { ...m, summary: "Update banner", params: idParam, body: bannerPatch, audit: audit("banner.updated") }, c.update)
  .patch("/:id/status", { ...m, summary: "Change status (live / scheduled / paused / draft / expired)", params: idParam, body: bannerStatusBody, audit: audit("banner.status_changed") }, c.setStatus)
  .post("/:id/duplicate", { ...m, summary: "Duplicate as a draft", params: idParam, status: 201, audit: audit("banner.duplicated") }, c.duplicate)
  .post("/:id/move", { ...m, summary: "Move up / down within its placement", params: idParam, body: moveBody, audit: audit("banner.reordered") }, c.move)
  .delete("/:id", { ...m, summary: "Delete banner", params: idParam, audit: audit("banner.deleted") }, c.remove);
