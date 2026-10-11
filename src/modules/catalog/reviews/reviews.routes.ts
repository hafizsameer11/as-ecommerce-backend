import { z } from "zod";
import { ModuleRouter, idParam, withMeta } from "@/core/http/router";
import { reviewsService as svc } from "./reviews.service";

export const reviewsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "", tag: "Reviews" })
  .get("/products/:id/reviews", {
    summary: "Published reviews + rating summary + fit summary",
    params: idParam,
    query: z.object({
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10),
      sort: z.enum(["recent", "helpful", "highest", "lowest"]).default("recent"), rating: z.coerce.number().int().min(1).max(5).optional(),
    }),
  }, async ({ params, query }) => {
    const r = await svc.listForProduct(params.id, query);
    return withMeta({ summary: r.summary, items: r.items }, r.meta);
  })
  .post("/products/:id/reviews", {
    summary: "Write a review (multipart; up to 4 photos in `photos`)",
    auth: "customer",
    params: idParam,
    upload: { field: "photos", maxCount: 4, maxMB: 8 },
    body: z.object({
      rating: z.coerce.number().int().min(1).max(5),
      title: z.string().trim().min(2).max(120),
      body: z.string().trim().min(10, "Please add a little more detail").max(4000),
      size: z.string().max(20).optional(),
      fit: z.enum(["runs_small", "true_to_size", "runs_large"]).optional(),
    }),
    status: 201,
  }, ({ customerId, params, body, files }) => svc.create(customerId, params.id, body, files))
  .post("/reviews/:id/helpful", { summary: "Mark review helpful", auth: "customer", params: idParam }, ({ customerId, params }) => svc.vote(customerId, params.id, "helpful"))
  .post("/reviews/:id/report", { summary: "Report review", auth: "customer", params: idParam }, ({ customerId, params }) => svc.vote(customerId, params.id, "report"));

const status = z.enum(["pending", "published", "rejected", "flagged"]);
const audit = (action: string) => ({ category: "catalog", action, entity: "review" });

/** asl-admin /reviews */
export const reviewsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/reviews", tag: "Reviews", defaultAuth: "admin", defaultPermission: "catalog.edit" })
  .get("/", {
    summary: "Moderation queue",
    permission: "catalog.view",
    query: z.object({
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
      status: status.optional(), rating: z.coerce.number().int().min(1).max(5).optional(), q: z.string().optional(), product: z.string().optional(),
    }),
  }, async ({ query }) => {
    const r = await svc.adminList(query);
    return withMeta(r.items, r.meta);
  })
  .patch("/:id/status", { summary: "Publish / reject / flag", params: idParam, body: z.object({ status, reason: z.string().max(200).optional() }), audit: audit("review.status") },
    ({ params, body }) => svc.setStatus([params.id], body.status, body.reason))
  .post("/bulk", {
    summary: "Bulk publish / reject / flag / delete",
    body: z.object({ ids: z.array(z.string()).min(1).max(500), action: z.enum(["publish", "reject", "flag", "delete"]) }),
    audit: audit("review.bulk"),
  }, ({ body }) =>
    body.action === "delete" ? svc.remove(body.ids) : svc.setStatus(body.ids, ({ publish: "published", reject: "rejected", flag: "flagged" } as const)[body.action]))
  .post("/:id/reply", { summary: "Public reply from ASL", params: idParam, body: z.object({ body: z.string().trim().min(1).max(2000) }), audit: audit("review.replied") },
    ({ params, body, admin }) => svc.reply(params.id, body.body, `ASL Support · ${admin.name}`))
  .delete("/:id", { summary: "Delete review", params: idParam, audit: audit("review.deleted") }, ({ params }) => svc.remove([params.id]));
