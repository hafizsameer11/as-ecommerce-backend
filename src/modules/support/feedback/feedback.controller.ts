import type { Ctx } from "@/core/http/router";
import { feedbackService as svc } from "./feedback.service";
import type { AdminFeedbackQuery, FeedbackBody, FeedbackStatusBody } from "./feedback.schemas";

type Id = { id: string };

export const feedbackController = {
  create: ({ customerId, body }: Ctx<FeedbackBody>) => svc.create(customerId, body),
  adminList: ({ query }: Ctx<unknown, AdminFeedbackQuery>) => svc.adminList(query),
  setStatus: async ({ params, body, res }: Ctx<FeedbackStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body.status);
    res.locals.audit = { entityId: params.id, before: r.before, after: { status: r.after.status }, summary: `Feedback marked ${body.status}` };
    return r.after;
  },
};
