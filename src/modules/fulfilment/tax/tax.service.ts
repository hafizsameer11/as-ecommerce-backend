import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { ExemptionBody, TaxCategoryBody, TaxRateBody } from "./tax.schemas";

/** ISO 3166-2:NG codes so "Lagos State" matches a rate with region "NG-LA" */
const NG_STATES: Record<string, string> = {
  abia: "AB", adamawa: "AD", "akwa ibom": "AK", anambra: "AN", bauchi: "BA", bayelsa: "BY", benue: "BE", borno: "BO", "cross river": "CR",
  delta: "DE", ebonyi: "EB", edo: "ED", ekiti: "EK", enugu: "EN", fct: "FC", abuja: "FC", "federal capital territory": "FC", gombe: "GO",
  imo: "IM", jigawa: "JI", kaduna: "KD", kano: "KN", katsina: "KT", kebbi: "KE", kogi: "KO", kwara: "KW", lagos: "LA", nasarawa: "NA",
  niger: "NI", ogun: "OG", ondo: "ON", osun: "OS", oyo: "OY", plateau: "PL", rivers: "RI", sokoto: "SO", taraba: "TA", yobe: "YO", zamfara: "ZA",
};
const stateCode = (country: string, state?: string) => {
  if (!state) return null;
  const k = state.toLowerCase().replace(/\bstate\b/g, "").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  return country === "NG" && NG_STATES[k] ? `NG-${NG_STATES[k]}` : `${country}-${k.toUpperCase()}`;
};

const toRate = (r: Awaited<ReturnType<typeof prisma.taxRate.findFirstOrThrow>>) => ({
  id: r.id, name: r.name, scope: r.scope, region: r.region, rate: r.rateBps / 100, basis: r.basis, appliesTo: r.appliesTo as string[],
  code: r.code, active: r.active, createdAt: r.createdAt,
});

export type TaxLine = { name: string; code: string; rate: number; basis: "inclusive" | "exclusive"; amount: number };

export const taxService = {
  /**
   * Tax for an order. Inclusive rates are only reported (already inside the price);
   * exclusive rates are added to the total.
   */
  async compute(input: { country: string; state?: string; postcode?: string; productsAmount: number; shippingAmount: number; conciergeFee?: number; customerEmail?: string }) {
    const settings = await settingsService.get("tax");
    if (input.customerEmail) {
      const ex = await prisma.taxExemption.findFirst({ where: { entity: "customer", reference: input.customerEmail, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] } });
      if (ex) return { added: 0, included: 0, lines: [] as TaxLine[], exempt: true };
    }
    const sc = stateCode(input.country, input.state);
    const rates = await prisma.taxRate.findMany({ where: { active: true } });
    const applicable = rates.filter(
      (r) => (r.scope === "country" && r.region.toUpperCase() === input.country) || (r.scope === "state" && r.region.toUpperCase() === sc) || (r.scope === "postcode" && !!input.postcode && input.postcode.startsWith(r.region)),
    );
    const lines: TaxLine[] = [];
    for (const r of applicable) {
      const on = r.appliesTo as string[];
      let base = 0;
      if (on.includes("products")) base += input.productsAmount;
      if (on.includes("shipping") && settings.chargeTaxOnShipping) base += input.shippingAmount;
      if (on.includes("concierge_fee") && settings.chargeTaxOnConcierge) base += input.conciergeFee ?? 0;
      if (!base) continue;
      // inclusive: the tax inside a gross amount = gross × r / (1 + r)
      const amount = r.basis === "inclusive" ? Math.round((base * r.rateBps) / (10_000 + r.rateBps)) : Math.round((base * r.rateBps) / 10_000);
      lines.push({ name: r.name, code: r.code, rate: r.rateBps / 100, basis: r.basis, amount });
    }
    return {
      added: lines.filter((l) => l.basis === "exclusive").reduce((n, l) => n + l.amount, 0),
      included: lines.filter((l) => l.basis === "inclusive").reduce((n, l) => n + l.amount, 0),
      lines,
      exempt: false,
    };
  },

  // ── admin /tax ──
  async overview() {
    const [rates, exemptions, categories, settings] = await Promise.all([
      prisma.taxRate.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.taxExemption.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.taxCategory.findMany({ orderBy: { name: "asc" } }),
      settingsService.get("tax"),
    ]);
    return {
      rates: rates.map(toRate),
      exemptions,
      categories: categories.map((c) => ({ ...c, overrides: (c.overrides as { region: string; rateBps: number }[]).map((o) => ({ region: o.region, rate: o.rateBps / 100 })) })),
      settings,
    };
  },
  async createRate(b: TaxRateBody) {
    const { rate, ...rest } = b;
    return toRate(await prisma.taxRate.create({ data: { ...rest, rateBps: Math.round(rate * 100) } }));
  },
  async updateRate(id: string, b: Partial<TaxRateBody>) {
    const { rate, ...rest } = b;
    const before = await prisma.taxRate.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Tax rate");
    const after = await prisma.taxRate.update({ where: { id }, data: { ...rest, ...(rate !== undefined ? { rateBps: Math.round(rate * 100) } : {}) } });
    return { before: toRate(before), after: toRate(after) };
  },
  async toggleRate(id: string) {
    const r = await prisma.taxRate.findUniqueOrThrow({ where: { id } });
    return toRate(await prisma.taxRate.update({ where: { id }, data: { active: !r.active } }));
  },
  async removeRate(id: string) {
    await prisma.taxRate.delete({ where: { id } });
    return { deleted: true };
  },
  addExemption: (b: ExemptionBody) => prisma.taxExemption.create({ data: b }),
  async removeExemption(id: string) {
    await prisma.taxExemption.delete({ where: { id } });
    return { deleted: true };
  },
  async createCategory(b: TaxCategoryBody) {
    return prisma.taxCategory.create({ data: { ...b, overrides: b.overrides.map((o) => ({ region: o.region, rateBps: Math.round(o.rate * 100) })) } });
  },
  async updateCategory(id: string, b: Partial<TaxCategoryBody>) {
    return prisma.taxCategory.update({
      where: { id },
      data: { ...b, ...(b.overrides ? { overrides: b.overrides.map((o) => ({ region: o.region, rateBps: Math.round(o.rate * 100) })) } : {}) },
    });
  },
};
