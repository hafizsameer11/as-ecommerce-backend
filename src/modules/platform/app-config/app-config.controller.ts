import type { Ctx } from "@/core/http/router";
import { appConfigService as svc } from "./app-config.service";
import type { AppConfigPatch, ConsentBody } from "./app-config.schemas";

export const appConfigController = {
  publicConfig: ({ req }: Ctx) => svc.publicConfig(req.header("x-app-version") ?? undefined),

  consent: ({ body, req }: Ctx<ConsentBody>) => svc.saveConsent(body, req.customer?.id),

  claimDownloadOffer: ({ customerId }: Ctx) => svc.claimDownloadOffer(customerId),

  adminConfig: () => svc.adminConfig(),

  async update({ body, admin, res }: Ctx<AppConfigPatch>) {
    const r = await svc.updateConfig(body, admin.email);
    res.locals.audit = { entityId: "app", summary: "Updated app configuration", before: r.before, after: r.after };
    return r.after;
  },
};
