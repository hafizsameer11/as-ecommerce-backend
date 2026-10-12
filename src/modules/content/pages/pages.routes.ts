import { ModuleRouter, idParam } from "@/core/http/router";
import { pagesController as c } from "./pages.controller";
import { blockAdd, blockMove, blockParams, blockPatch, pageCreate, pageListQuery, pagePatch, pageStatusBody, storeSlugParams } from "./pages.schemas";

/** asl-web / asl-mobile: customer-care pages, /how-it-works, /concierge-service … rendered from blocks */
export const pagesStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/content", tag: "Content", defaultAuth: "optionalCustomer" })
  .get("/navigation", { summary: "Header / footer links (published pages with showInHeader / showInFooter)" }, c.navigation)
  .get("/pages/*slug", {
    summary: "Published page by slug (e.g. customer-care/return-policy)",
    description: "Business values in the copy (return window, delivery fees and times, free-shipping threshold, refund days, support hours…) " +
      "are rendered from settings and shipping zones at request time. `members` pages need a signed-in customer (401).",
    params: storeSlugParams,
  }, c.bySlug);

const audit = (action: string) => ({ category: "content", action, entity: "page" });

/** asl-admin /content/pages */
export const pagesAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/content/pages", tag: "Content pages", defaultAuth: "admin", defaultPermission: "content.publish" })
  .get("/", { summary: "Pages (tabs by status, KPIs, search)", query: pageListQuery }, c.list)
  .get("/tokens", { summary: "Values editors can insert in copy ({{returns.windowDays}} …) with their current value" }, c.tokens)
  .get("/:id", { summary: "Page", params: idParam }, c.get)
  .get("/:id/preview", { summary: "Preview as the storefront renders it (any status) + unknown-token warnings", params: idParam }, c.preview)
  .post("/", { summary: "Create page", body: pageCreate, status: 201, audit: audit("page.created") }, c.create)
  .patch("/:id", { summary: "Update page (blocks replaced when sent)", params: idParam, body: pagePatch, audit: audit("page.updated") }, c.update)
  .delete("/:id", { summary: "Delete page", params: idParam, audit: audit("page.deleted") }, c.remove)
  .post("/:id/duplicate", { summary: "Duplicate as draft", params: idParam, status: 201, audit: audit("page.duplicated") }, c.duplicate)
  .patch("/:id/status", { summary: "draft · scheduled (needs scheduledFor) · published · archived", params: idParam, body: pageStatusBody, audit: audit("page.status_changed") }, c.setStatus)
  .post("/:id/blocks", { summary: "Add block (type; fields optional — defaults filled in)", params: idParam, body: blockAdd, status: 201, audit: audit("page.block_added") }, c.addBlock)
  .patch("/:id/blocks/:blockId", { summary: "Update block (validated per type; rich text sanitised)", params: blockParams, body: blockPatch, audit: audit("page.block_updated") }, c.updateBlock)
  .delete("/:id/blocks/:blockId", { summary: "Remove block", params: blockParams, audit: audit("page.block_removed") }, c.removeBlock)
  .post("/:id/blocks/:blockId/move", { summary: "Move block ({dir: -1|1} or {to: index})", params: blockParams, body: blockMove, audit: audit("page.block_moved") }, c.moveBlock);
