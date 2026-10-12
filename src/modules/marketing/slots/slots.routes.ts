import { ModuleRouter, idParam } from "@/core/http/router";
import { canMerchandise as access, MERCH_ACCESS_NOTE as description } from "../impressions/placements";
import { moveBody } from "../banners/banners.schemas";
import { slotsController as c } from "./slots.controller";
import { slotBody, slotImageBody, slotListQuery, slotPatch, slotReorderBody, slotStatusBody, storeSlotsQuery } from "./slots.schemas";

const audit = (action: string) => ({ category: "marketing", action, entity: "slot" });
const m = { description, middleware: [access] };

/** Storefront page slots (home slots are also part of GET /store/home). */
export const slotsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/slots", tag: "Merchandising", defaultAuth: "optionalCustomer" })
  .get("/", { summary: "Live slots of a page for the caller (pinned first, then position)", query: storeSlotsQuery }, c.storeList);

/** asl-admin /slots ("Homepage Slots") */
export const slotsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/slots", tag: "Slots", defaultAuth: "admin" })
  .get("/", { ...m, summary: "Slots (?slotPage=home…, status tab; tabs, per-page counts, KPIs incl. CTR + revenue)", query: slotListQuery }, c.list)
  .post("/reorder", { ...m, summary: "Reorder a page (ids in display order → position 1..n)", body: slotReorderBody, audit: audit("slot.reordered") }, c.reorder)
  .get("/:id", { ...m, summary: "Slot", params: idParam }, c.get)
  .post("/", { ...m, summary: "Create slot (imageUrl = a URL or a media-library URL)", body: slotBody, status: 201, audit: audit("slot.created") }, c.create)
  .patch("/:id", { ...m, summary: "Update slot", params: idParam, body: slotPatch, audit: audit("slot.updated") }, c.update)
  .post("/:id/image", {
    ...m, summary: "Upload the slot image (multipart `file`; saved to the media library folder hero / campaigns)",
    params: idParam, upload: { field: "file", maxMB: 10 }, body: slotImageBody, audit: audit("slot.updated"),
  }, c.uploadImage)
  .patch("/:id/status", { ...m, summary: "Change status (live with a future start → scheduled)", params: idParam, body: slotStatusBody, audit: audit("slot.status_changed") }, c.setStatus)
  .post("/:id/pin", { ...m, summary: "Pin / unpin (pinned slots render first)", params: idParam, audit: audit("slot.pinned") }, c.togglePin)
  .post("/:id/duplicate", { ...m, summary: "Duplicate as a draft", params: idParam, status: 201, audit: audit("slot.duplicated") }, c.duplicate)
  .post("/:id/move", { ...m, summary: "Move up / down within its page", params: idParam, body: moveBody, audit: audit("slot.reordered") }, c.move)
  .delete("/:id", { ...m, summary: "Delete slot", params: idParam, audit: audit("slot.deleted") }, c.remove);
