import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsDefaults, settingsSchemas, type SettingsGroup, type SettingsOf, PUBLIC_GROUPS } from "./settings.defaults";
import { STATUS_LABELS } from "./status-labels";

const TTL = 30_000;
const cache = new Map<SettingsGroup, { at: number; value: unknown }>();

async function get<G extends SettingsGroup>(group: G): Promise<SettingsOf<G>> {
  const c = cache.get(group);
  if (c && Date.now() - c.at < TTL) return c.value as SettingsOf<G>;
  const row = await prisma.setting.findUnique({ where: { group } });
  // merge so new keys added in code get their defaults
  const value = { ...settingsDefaults[group], ...((row?.value as object) ?? {}) } as SettingsOf<G>;
  cache.set(group, { at: Date.now(), value });
  return value;
}

async function update<G extends SettingsGroup>(group: G, patch: Partial<SettingsOf<G>>, by: string) {
  const current = await get(group);
  const next = settingsSchemas[group].parse({ ...current, ...patch }) as SettingsOf<G>;
  await prisma.setting.upsert({
    where: { group },
    create: { group, value: next as object, updatedBy: by },
    update: { value: next as object, updatedBy: by },
  });
  cache.delete(group);
  return { before: current, after: next };
}

async function publicSettings() {
  const groups = Object.fromEntries(await Promise.all(PUBLIC_GROUPS.map(async (g) => [g, await get(g)])));
  const [locales, currencies, paymentMethods, tiers, zones] = await Promise.all([
    prisma.locale.findMany({ where: { enabled: true }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { enabled: true }, orderBy: { code: "asc" } }),
    prisma.paymentMethodSetting.findMany({ where: { enabled: true }, orderBy: { position: "asc" } }),
    prisma.clubTier.findMany({ where: { active: true }, orderBy: { position: "asc" } }),
    prisma.shippingZone.findMany({
      where: { active: true },
      orderBy: { priority: "asc" },
      include: { rates: { where: { active: true }, orderBy: { position: "asc" } } },
    }),
  ]);
  return {
    ...groups,
    locales: locales.map((l) => ({ code: l.code, label: l.label, default: l.isDefault })),
    currencies: currencies.map((c) => ({ code: c.code, label: c.label, rate: c.rateX10000 / 10000, default: c.isDefault })),
    paymentMethods: paymentMethods.map((p) => ({ id: p.id, label: p.label, provider: p.provider, testMode: p.testMode, fee: p.feeLabel })),
    tiers: tiers.map((t) => ({
      id: t.id, name: t.name, color: t.color, minSpend: Number(t.minSpend), multiplier: t.multiplierX100 / 100, perks: t.perks,
    })),
    /** U1: delivery-fee table rendered by checkout AND the shipping-policy page */
    deliveryRates: zones.map((z) => ({
      zone: z.name,
      rates: z.rates.map((r) => ({ name: r.name, carrier: r.carrier, fee: r.baseFee, eta: r.etaDays, freeAbove: r.freeAbove })),
    })),
    labels: STATUS_LABELS,
  };
}

/* ── admin ─────────────────────────────────────────────────────────────── */

async function adminAll() {
  const groups = Object.keys(settingsDefaults) as SettingsGroup[];
  const values = Object.fromEntries(await Promise.all(groups.map(async (g) => [g, await get(g)])));
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
}

async function togglePaymentMethod(id: string, key: "enabled" | "testMode") {
  const pm = await prisma.paymentMethodSetting.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.paymentMethodSetting.update({ where: { id: pm.id }, data: { [key]: !pm[key] } });
  cache.clear();
  return { before: pm, after: updated };
}

async function toggleLocale(code: string) {
  const l = await prisma.locale.findUniqueOrThrow({ where: { code } });
  if (l.isDefault && l.enabled) throw ApiError.badRequest("INVALID_STATE", "The default language can't be disabled.");
  return prisma.locale.update({ where: { code: l.code }, data: { enabled: !l.enabled } });
}

async function setDefaultLocale(code: string) {
  await prisma.$transaction([
    prisma.locale.updateMany({ data: { isDefault: false } }),
    prisma.locale.update({ where: { code }, data: { isDefault: true, enabled: true } }),
  ]);
  return prisma.locale.findMany({ orderBy: { code: "asc" } });
}

async function toggleCurrency(code: string) {
  const c = await prisma.currency.findUniqueOrThrow({ where: { code } });
  if (c.isDefault && c.enabled) throw ApiError.badRequest("INVALID_STATE", "The default currency can't be disabled.");
  return prisma.currency.update({ where: { code: c.code }, data: { enabled: !c.enabled } });
}

async function setDefaultCurrency(code: string) {
  await prisma.$transaction([
    prisma.currency.updateMany({ data: { isDefault: false } }),
    prisma.currency.update({ where: { code }, data: { isDefault: true, enabled: true } }),
  ]);
  return prisma.currency.findMany({ orderBy: { code: "asc" } });
}

async function setRate(code: string, rate: number) {
  cache.clear();
  return prisma.currency.update({ where: { code }, data: { rateX10000: Math.round(rate * 10000) } });
}

/** FX refresh – static provider today; swap for a live FX API later */
async function refreshFx() {
  cache.clear();
  return { refreshedAt: new Date().toISOString(), currencies: await prisma.currency.findMany() };
}

export const settingsService = {
  get, update, publicSettings, clearCache: () => cache.clear(),
  adminAll, togglePaymentMethod, toggleLocale, setDefaultLocale, toggleCurrency, setDefaultCurrency, setRate, refreshFx,
};
