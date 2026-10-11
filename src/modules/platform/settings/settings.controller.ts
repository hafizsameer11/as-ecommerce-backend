import type { Ctx } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "./settings.service";
import { settingsDefaults, type SettingsGroup } from "./settings.defaults";

export const settingsController = {
  publicSettings: () => settingsService.publicSettings(),

  async adminAll() {
    const groups = Object.keys(settingsDefaults) as SettingsGroup[];
    const values = Object.fromEntries(await Promise.all(groups.map(async (g) => [g, await settingsService.get(g)])));
    const [locales, currencies, paymentMethods] = await Promise.all([
      prisma.locale.findMany({ orderBy: { code: "asc" } }),
      prisma.currency.findMany({ orderBy: { code: "asc" } }),
      prisma.paymentMethodSetting.findMany({ orderBy: { position: "asc" } }),
    ]);
    return {
      ...values,
      locales,
      currencies: currencies.map((c) => ({ ...c, rate: c.rateX10000 / 10000 })),
      paymentMethods,
    };
  },

  async updateGroup({ params, body, admin, res }: Ctx<Record<string, unknown>, unknown, { group: SettingsGroup }>) {
    if (!(params.group in settingsDefaults)) throw ApiError.notFound("Settings group");
    const r = await settingsService.update(params.group, body as any, admin.email);
    res.locals.audit = { entityId: params.group, summary: `Updated ${params.group} settings`, before: r.before, after: r.after };
    return r.after;
  },

  async togglePayment({ params, body, res }: Ctx<{ key: "enabled" | "testMode" }, unknown, { id: string }>) {
    const pm = await prisma.paymentMethodSetting.findUniqueOrThrow({ where: { id: params.id } });
    const updated = await prisma.paymentMethodSetting.update({ where: { id: pm.id }, data: { [body.key]: !pm[body.key] } });
    settingsService.clearCache();
    res.locals.audit = { entityId: pm.id, summary: `${pm.label}: ${body.key} → ${updated[body.key]}` };
    return updated;
  },

  async toggleLocale({ params }: Ctx<unknown, unknown, { code: string }>) {
    const l = await prisma.locale.findUniqueOrThrow({ where: { code: params.code } });
    if (l.isDefault && l.enabled) throw ApiError.badRequest("INVALID_STATE", "The default language can't be disabled.");
    return prisma.locale.update({ where: { code: l.code }, data: { enabled: !l.enabled } });
  },

  async defaultLocale({ params }: Ctx<unknown, unknown, { code: string }>) {
    await prisma.$transaction([
      prisma.locale.updateMany({ data: { isDefault: false } }),
      prisma.locale.update({ where: { code: params.code }, data: { isDefault: true, enabled: true } }),
    ]);
    return prisma.locale.findMany({ orderBy: { code: "asc" } });
  },

  async toggleCurrency({ params }: Ctx<unknown, unknown, { code: string }>) {
    const c = await prisma.currency.findUniqueOrThrow({ where: { code: params.code } });
    if (c.isDefault && c.enabled) throw ApiError.badRequest("INVALID_STATE", "The default currency can't be disabled.");
    return prisma.currency.update({ where: { code: c.code }, data: { enabled: !c.enabled } });
  },

  async defaultCurrency({ params }: Ctx<unknown, unknown, { code: string }>) {
    await prisma.$transaction([
      prisma.currency.updateMany({ data: { isDefault: false } }),
      prisma.currency.update({ where: { code: params.code }, data: { isDefault: true, enabled: true } }),
    ]);
    return prisma.currency.findMany({ orderBy: { code: "asc" } });
  },

  async setRate({ params, body }: Ctx<{ rate: number }, unknown, { code: string }>) {
    settingsService.clearCache();
    return prisma.currency.update({ where: { code: params.code }, data: { rateX10000: Math.round(body.rate * 10000) } });
  },

  /** FX refresh – static provider today; swap for a live FX API later */
  async refreshFx() {
    settingsService.clearCache();
    return { refreshedAt: new Date().toISOString(), currencies: await prisma.currency.findMany() };
  },
};
