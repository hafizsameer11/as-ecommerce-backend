import { withMeta, type Ctx } from "@/core/http/router";
import { reviewsService as svc } from "./reviews.service";
import type { AdminReviewsQuery, ProductReviewsQuery, ReviewBody, ReviewBulkBody, ReviewReplyBody, ReviewStatusBody } from "./reviews.schemas";

type Id = { id: string };

export const reviewsController = {
  // store
  listForProduct: async ({ params, query }: Ctx<unknown, ProductReviewsQuery, Id>) => {
    const r = await svc.listForProduct(params.id, query);
    return withMeta({ summary: r.summary, items: r.items }, r.meta);
  },
  create: ({ customerId, params, body, files }: Ctx<ReviewBody, unknown, Id>) => svc.create(customerId, params.id, body, files),
  helpful: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.vote(customerId, params.id, "helpful"),
  report: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.vote(customerId, params.id, "report"),

  // admin
  adminList: async ({ query }: Ctx<unknown, AdminReviewsQuery>) => {
    const r = await svc.adminList(query);
    return withMeta(r.items, r.meta);
  },
  setStatus: ({ params, body }: Ctx<ReviewStatusBody, unknown, Id>) => svc.setStatus([params.id], body.status, body.reason),
  bulk: ({ body }: Ctx<ReviewBulkBody>) =>
    body.action === "delete" ? svc.remove(body.ids) : svc.setStatus(body.ids, ({ publish: "published", reject: "rejected", flag: "flagged" } as const)[body.action]),
  reply: ({ params, body, admin }: Ctx<ReviewReplyBody, unknown, Id>) => svc.reply(params.id, body.body, `ASL Support · ${admin.name}`),
  remove: ({ params }: Ctx<unknown, unknown, Id>) => svc.remove([params.id]),
};
