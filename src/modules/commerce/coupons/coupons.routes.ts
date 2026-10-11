import { ModuleRouter, idParam } from "@/core/http/router";
import { pageQuery } from "@/core/http/pagination";
import { couponsController as c } from "./coupons.controller";
import { couponBody, couponListQuery, couponPatch, statusBody } from "./coupons.schemas";

/** "Your coupons" chips (personal codes from rewards / referrals). Applying a code is POST /checkout/coupon. */
export const myCouponsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/me/coupons", tag: "Coupons", defaultAuth: "customer" })
  .get("/", { summary: "My unused personal coupon codes" }, c.mine);

const audit = (action: string) => ({ category: "marketing", action, entity: "coupon" });

/** asl-admin /coupons */
export const couponsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/coupons", tag: "Coupons", defaultAuth: "admin", defaultPermission: "marketing.manage" })
  .get("/", { summary: "Coupons (tabs, KPIs, search)", query: couponListQuery }, c.list)
  .get("/:id", { summary: "Coupon", params: idParam }, c.get)
  .get("/:id/redemptions", { summary: "Who used it", params: idParam, query: pageQuery }, c.redemptions)
  .post("/", { summary: "Create coupon", body: couponBody, status: 201, audit: audit("coupon.created") }, c.create)
  .patch("/:id", { summary: "Update coupon", params: idParam, body: couponPatch, audit: audit("coupon.updated") }, c.update)
  .post("/:id/duplicate", { summary: "Duplicate (as draft)", params: idParam, status: 201, audit: audit("coupon.duplicated") }, c.duplicate)
  .patch("/:id/status", { summary: "Activate / pause / expire", params: idParam, body: statusBody, audit: audit("coupon.status_changed") }, c.setStatus)
  .post("/:id/pin", { summary: "Pin / unpin", params: idParam }, c.togglePin)
  .delete("/:id", { summary: "Delete coupon (past redemptions keep the code)", params: idParam, audit: audit("coupon.deleted") }, c.remove);
