import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "./settings.service";
import { settingsDefaults, type SettingsGroup } from "./settings.defaults";
import type { CodeParam, PaymentToggleBody, RateBody, SettingsGroupPatch } from "./settings.schemas";

export const settingsController = {
  publicSettings: () => settingsService.publicSettings(),

  adminAll: () => settingsService.adminAll(),

  async updateGroup({ params, body, admin, res }: Ctx<SettingsGroupPatch, unknown, { group: SettingsGroup }>) {
    if (!(params.group in settingsDefaults)) throw ApiError.notFound("Settings group");
    const r = await settingsService.update(params.group, body as any, admin.email);
    res.locals.audit = { entityId: params.group, summary: `Updated ${params.group} settings`, before: r.before, after: r.after };
    return r.after;
  },

  async togglePayment({ params, body, res }: Ctx<PaymentToggleBody, unknown, { id: string }>) {
    const { before: pm, after: updated } = await settingsService.togglePaymentMethod(params.id, body.key);
    res.locals.audit = { entityId: pm.id, summary: `${pm.label}: ${body.key} → ${updated[body.key]}` };
    return updated;
  },

  toggleLocale: ({ params }: Ctx<unknown, unknown, CodeParam>) => settingsService.toggleLocale(params.code),
  defaultLocale: ({ params }: Ctx<unknown, unknown, CodeParam>) => settingsService.setDefaultLocale(params.code),
  toggleCurrency: ({ params }: Ctx<unknown, unknown, CodeParam>) => settingsService.toggleCurrency(params.code),
  defaultCurrency: ({ params }: Ctx<unknown, unknown, CodeParam>) => settingsService.setDefaultCurrency(params.code),
  setRate: ({ params, body }: Ctx<RateBody, unknown, CodeParam>) => settingsService.setRate(params.code, body.rate),
  refreshFx: () => settingsService.refreshFx(),
};
