import type { Ctx } from "@/core/http/router";
import { impressionsService as svc } from "./impressions.service";
import type { ImpressionsBody } from "./impressions.schemas";

export const impressionsController = {
  record: ({ body }: Ctx<ImpressionsBody>) => svc.record(body),
};
