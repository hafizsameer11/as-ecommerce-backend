import type { Ctx } from "@/core/http/router";
import { homeService as svc } from "./home.service";

export const homeController = {
  home: ({ req }: Ctx) => svc.home(req.customer?.id),
};
