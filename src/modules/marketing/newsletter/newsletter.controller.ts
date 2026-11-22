import type { Ctx } from "@/core/http/router";
import { newsletterService as svc } from "./newsletter.service";
import type { NewsletterBody } from "./newsletter.schemas";

export const newsletterController = {
  subscribe: ({ body, customerId }: Ctx<NewsletterBody>) => svc.subscribe(body, customerId),
};