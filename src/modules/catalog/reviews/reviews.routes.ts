import { ModuleRouter, idParam } from "@/core/http/router";
import { reviewsController as c } from "./reviews.controller";
import { adminReviewsQuery, productReviewsQuery, reviewBody, reviewBulkBody, reviewReplyBody, reviewStatusBody } from "./reviews.schemas";

export const reviewsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "", tag: "Reviews" })
  .get("/products/:id/reviews", { summary: "Published reviews + rating summary + fit summary", params: idParam, query: productReviewsQuery }, c.listForProduct)
  .post("/products/:id/reviews", {
    summary: "Write a review (multipart; up to 4 photos in `photos`)",
    auth: "customer",
    params: idParam,
    upload: { field: "photos", maxCount: 4, maxMB: 8 },
    body: reviewBody,
    status: 201,
  }, c.create)
  .post("/reviews/:id/helpful", { summary: "Mark review helpful", auth: "customer", params: idParam }, c.helpful)
  .post("/reviews/:id/report", { summary: "Report review", auth: "customer", params: idParam }, c.report);

const audit = (action: string) => ({ category: "catalog", action, entity: "review" });

/** asl-admin /reviews */
export const reviewsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/reviews", tag: "Reviews", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", { summary: "Moderation queue", permission: "catalog.view", query: adminReviewsQuery }, c.adminList)
  .patch("/:id/status", { summary: "Publish / reject / flag", params: idParam, body: reviewStatusBody, audit: audit("review.status") }, c.setStatus)
  .post("/bulk", { summary: "Bulk publish / reject / flag / delete", body: reviewBulkBody, audit: audit("review.bulk") }, c.bulk)
  .post("/:id/reply", { summary: "Public reply from ASL", params: idParam, body: reviewReplyBody, audit: audit("review.replied") }, c.reply)
  .delete("/:id", { summary: "Delete review", params: idParam, audit: audit("review.deleted") }, c.remove);
