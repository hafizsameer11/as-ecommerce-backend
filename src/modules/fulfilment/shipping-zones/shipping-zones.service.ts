/**
 * U1: the ONLY place delivery fees come from. Checkout, the shipping-policy page and the
 * admin all read these zones, so the numbers can no longer disagree.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import type { QuoteQuery, RateBody, ZoneBody } from "./shipping-zones.schemas";

type ZoneRow = Prisma.ShippingZoneGetPayload<{ include: { rates: true } }>;

const CARRIER_LABEL: Record<string, string> = { InHouse: "In-house" };
const COUNTRY_ALIASES: Record<string, string> = { nigeria: "NG", ng: "NG", "united kingdom": "GB", uk: "GB", "united states": "US", usa: "US", ghana: "GH" };

/** "Lagos State" → "lagos", "FCT - Abuja" → "fct abuja" */
const norm = (s: string) => s.toLowerCase().replace(/\bstate\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
export const countryCode = (c: string) => (c.length === 2 ? c.toUpperCase() : (COUNTRY_ALIASES[c.toLowerCase()] ?? c.toUpperCase()));

const toRate = (r: ZoneRow["rates"][number]) => ({
  id: r.id, name: r.name, carrier: r.carrier, carrierLabel: CARRIER_LABEL[r.carrier] ?? r.carrier, service: r.service, baseFee: r.baseFee,
  perKgFee: r.perKgFee, minKg: r.minKg, maxKg: r.maxKg, etaDays: r.etaDays, freeAbove: r.freeAbove, active: r.active, position: r.position,
});
const toZone = (z: ZoneRow) => ({
  id: z.id, name: z.name, scope: z.scope, countries: z.countries as string[], regions: z.regions as string[], priority: z.priority,
  active: z.active, notes: z.notes, createdAt: z.createdAt, rates: z.rates.sort((a, b) => a.position - b.position).map(toRate),
});

function matches(z: ZoneRow, d: { country: string; state?: string; city?: string; postcode?: string }) {
  const countries = (z.countries as string[]).map((c) => c.toUpperCase());
  if (!countries.includes("*") && !countries.includes(d.country)) return false;
  const regions = (z.regions as string[]).map(norm);
  if (z.scope === "country" || !regions.length) return true;
  const value = z.scope === "state" ? d.state : z.scope === "city" ? d.city : d.postcode;
  if (!value) return false;
  const v = norm(value);
  return regions.some((r) => r === v || v.split(" ").includes(r) || (z.scope === "postcode" && v.startsWith(r)));
}

/** fee for one rate: free above threshold, otherwise base + per-kg above the included weight */
function price(r: ZoneRow["rates"][number], subtotal: number, weightKg: number) {
  if (r.freeAbove != null && subtotal >= r.freeAbove) return 0;
  const extraKg = Math.max(0, Math.ceil(weightKg) - Math.max(1, Math.ceil(r.minKg)));
  return r.baseFee + extraKg * r.perKgFee;
}

export const shippingZonesService = {
  /** Rates for a destination, from the highest-priority (lowest number) matching zone. */
  async quote(q: QuoteQuery) {
    const country = countryCode(q.country);
    const zones = await prisma.shippingZone.findMany({ where: { active: true }, include: { rates: { where: { active: true } } }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    const zone = zones.find((z) => z.rates.length && matches(z, { country, state: q.state, city: q.city, postcode: q.postcode }));
    if (!zone) return { zone: null, options: [] as ReturnType<typeof toOption>[] };
    const weightKg = q.weightKg ?? 1;
    const options = zone.rates
      .filter((r) => weightKg <= r.maxKg)
      .sort((a, b) => a.position - b.position)
      .map((r) => toOption(r, price(r, q.subtotal, weightKg)));
    return { zone: { id: zone.id, name: zone.name }, options };
  },

  /** one specific rate, re-priced (used at place-order) */
  async price(rateId: string | null | undefined, q: QuoteQuery) {
    const { zone, options } = await this.quote(q);
    if (!zone || !options.length) throw ApiError.badRequest("VALIDATION_FAILED", "We don't deliver to this address yet. Choose pick-up in store or contact support.");
    return options.find((o) => o.id === rateId) ?? options[0];
  },

  /** shipping-policy page table (U1) */
  async table() {
    const zones = await prisma.shippingZone.findMany({ where: { active: true }, include: { rates: { where: { active: true } } }, orderBy: { priority: "asc" } });
    return zones.map((z) => ({ zone: z.name, rates: z.rates.map((r) => ({ name: r.name, fee: r.baseFee, perKgFee: r.perKgFee, eta: r.etaDays, freeAbove: r.freeAbove, carrier: CARRIER_LABEL[r.carrier] ?? r.carrier })) }));
  },

  // ── admin /shipping-zones ──
  async list() {
    const since = new Date(Date.now() - 30 * 86400_000);
    const zones = await prisma.shippingZone.findMany({ include: { rates: true }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    // orders/revenue last 30 days per zone (matched by shipping rate name)
    const stats = await prisma.order.groupBy({
      by: ["shippingRateName"], where: { placedAt: { gte: since }, paymentStatus: "paid" }, _count: { _all: true }, _sum: { shipping: true },
    });
    return zones.map((z) => {
      const names = new Set(z.rates.map((r) => r.name));
      const mine = stats.filter((s) => s.shippingRateName && names.has(s.shippingRateName));
      return { ...toZone(z), ordersLast30: mine.reduce((n, s) => n + s._count._all, 0), revenueLast30: mine.reduce((n, s) => n + (s._sum.shipping ?? 0), 0) };
    });
  },

  async get(id: string) {
    const z = await prisma.shippingZone.findUnique({ where: { id }, include: { rates: true } });
    if (!z) throw ApiError.notFound("Shipping zone");
    return toZone(z);
  },

  async create(input: ZoneBody) {
    const { rates, ...zone } = input;
    const z = await prisma.shippingZone.create({
      data: { ...zone, rates: rates ? { create: rates.map((r, i) => ({ ...r, position: r.position ?? i })) } : undefined },
      include: { rates: true },
    });
    return toZone(z);
  },

  async update(id: string, patch: Partial<ZoneBody>) {
    const before = await this.get(id);
    const { rates, ...zone } = patch;
    const z = await prisma.$transaction(async (tx) => {
      if (rates) {
        await tx.zoneRate.deleteMany({ where: { zoneId: id } });
        await tx.zoneRate.createMany({ data: rates.map((r, i) => ({ ...r, zoneId: id, position: r.position ?? i })) });
      }
      return tx.shippingZone.update({ where: { id }, data: zone, include: { rates: true } });
    });
    return { before, after: toZone(z) };
  },

  async duplicate(id: string) {
    const z = await prisma.shippingZone.findUniqueOrThrow({ where: { id }, include: { rates: true } });
    const copy = await prisma.shippingZone.create({
      data: {
        name: `${z.name} (copy)`, scope: z.scope, countries: z.countries as string[], regions: z.regions as string[], priority: z.priority, active: false, notes: z.notes,
        rates: { create: z.rates.map(({ id: _id, zoneId: _z, ...r }) => r) },
      },
      include: { rates: true },
    });
    return toZone(copy);
  },

  async toggle(id: string) {
    const z = await prisma.shippingZone.findUniqueOrThrow({ where: { id } });
    return toZone(await prisma.shippingZone.update({ where: { id }, data: { active: !z.active }, include: { rates: true } }));
  },

  async remove(id: string) {
    await prisma.shippingZone.delete({ where: { id } });
    return { deleted: true };
  },

  async upsertRate(zoneId: string, rateId: string | null, input: RateBody) {
    await this.get(zoneId);
    if (rateId) {
      const r = await prisma.zoneRate.findFirst({ where: { id: rateId, zoneId } });
      if (!r) throw ApiError.notFound("Rate");
      await prisma.zoneRate.update({ where: { id: rateId }, data: input });
    } else {
      const position = input.position ?? (await prisma.zoneRate.count({ where: { zoneId } }));
      await prisma.zoneRate.create({ data: { ...input, zoneId, position } });
    }
    return this.get(zoneId);
  },

  async removeRate(zoneId: string, rateId: string) {
    await prisma.zoneRate.deleteMany({ where: { id: rateId, zoneId } });
    return this.get(zoneId);
  },
};

function toOption(r: ZoneRow["rates"][number], fee: number) {
  return { id: r.id, name: r.name, carrier: CARRIER_LABEL[r.carrier] ?? r.carrier, service: r.service, eta: r.etaDays, fee, free: fee === 0, freeAbove: r.freeAbove };
}
