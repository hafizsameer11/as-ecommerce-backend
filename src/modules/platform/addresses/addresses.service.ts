import type { Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { toCsv } from "@/core/utils/csv";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import type { AddressBody, AddressPatch, AdminAddressQuery } from "./addresses.schemas";

type Row = Prisma.AddressGetPayload<{ include: { customer: { select: { firstName: true; lastName: true; email: true } } } }>;

export const toAddress = (a: Prisma.AddressGetPayload<object>) => ({
  id: a.id, label: a.label, type: a.type, recipient: a.recipient, phone: a.phone, line1: a.line1, line2: a.line2,
  city: a.city, state: a.state, country: a.country, postalCode: a.postalCode, isDefault: a.isDefault,
});
const toAdmin = (a: Row) => ({
  ...toAddress(a), customerId: a.customerId, customerName: fullName(a.customer), customerEmail: a.customer.email,
  verified: a.verified, flagged: a.flagged, notes: a.notes, ordersShipped: a.ordersShipped, lastUsedAt: a.lastUsedAt, createdAt: a.createdAt,
});

/** only one default per customer and type */
async function clearDefault(tx: Tx, customerId: string, type: string, except?: string) {
  await tx.address.updateMany({ where: { customerId, type, isDefault: true, ...(except ? { id: { not: except } } : {}) }, data: { isDefault: false } });
}

async function owned(customerId: string, id: string) {
  const a = await prisma.address.findFirst({ where: { id, customerId } });
  if (!a) throw ApiError.notFound("Address");
  return a;
}

export const addressesService = {
  async list(customerId: string) {
    const rows = await prisma.address.findMany({ where: { customerId }, orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }] });
    return rows.map(toAddress);
  },

  async get(customerId: string, id: string) {
    return toAddress(await owned(customerId, id));
  },

  async defaultFor(customerId: string, type = "shipping") {
    const a = await prisma.address.findFirst({ where: { customerId, type }, orderBy: [{ isDefault: "desc" }, { lastUsedAt: "desc" }] });
    return a ? toAddress(a) : null;
  },

  async create(customerId: string, input: AddressBody) {
    if ((await prisma.address.count({ where: { customerId } })) >= 20) throw ApiError.badRequest("VALIDATION_FAILED", "You can save up to 20 addresses.");
    return prisma.$transaction(async (tx) => {
      const first = (await tx.address.count({ where: { customerId, type: input.type } })) === 0;
      const isDefault = input.isDefault ?? first;
      if (isDefault) await clearDefault(tx, customerId, input.type);
      return toAddress(await tx.address.create({ data: { ...input, customerId, isDefault } }));
    });
  },

  async update(customerId: string, id: string, patch: AddressPatch) {
    const before = await owned(customerId, id);
    return prisma.$transaction(async (tx) => {
      if (patch.isDefault) await clearDefault(tx, customerId, patch.type ?? before.type, id);
      // an edited address must be re-verified by the team
      return toAddress(await tx.address.update({ where: { id }, data: { ...patch, verified: false } }));
    });
  },

  async setDefault(customerId: string, id: string) {
    const a = await owned(customerId, id);
    await prisma.$transaction(async (tx) => {
      await clearDefault(tx, customerId, a.type, id);
      await tx.address.update({ where: { id }, data: { isDefault: true } });
    });
    return this.list(customerId);
  },

  async remove(customerId: string, id: string) {
    const a = await owned(customerId, id);
    await prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });
      if (a.isDefault) {
        const next = await tx.address.findFirst({ where: { customerId, type: a.type }, orderBy: { updatedAt: "desc" } });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    return { deleted: true };
  },

  /** checkout: remember a new shipping address on the account (dedupes by line1 + city) */
  async rememberFromCheckout(tx: Tx, customerId: string, a: { fullName: string; phone: string; address: string; apartment?: string | null; city: string; state: string; postal?: string | null; country: string }) {
    const existing = await tx.address.findFirst({ where: { customerId, type: "shipping", line1: a.address, city: a.city } });
    if (existing) return tx.address.update({ where: { id: existing.id }, data: { lastUsedAt: new Date(), ordersShipped: { increment: 1 } } });
    const first = (await tx.address.count({ where: { customerId, type: "shipping" } })) === 0;
    return tx.address.create({
      data: {
        customerId, label: "Home", type: "shipping", recipient: a.fullName, phone: a.phone, line1: a.address, line2: a.apartment || null,
        city: a.city, state: a.state, country: a.country, postalCode: a.postal || null, isDefault: first, lastUsedAt: new Date(), ordersShipped: 1,
      },
    });
  },

  // ── admin /addresses ──
  where(q: AdminAddressQuery): Prisma.AddressWhereInput {
    const tab: Prisma.AddressWhereInput =
      q.tab === "flagged" ? { flagged: true } : q.tab === "unverified" ? { verified: false } : q.tab === "all" ? {} : { type: q.tab };
    return {
      ...tab,
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.q ? { OR: [{ line1: { contains: q.q } }, { city: { contains: q.q } }, { recipient: { contains: q.q } }, { phone: { contains: q.q } }, { customer: { email: { contains: q.q } } }] } : {}),
    };
  },

  async adminList(q: AdminAddressQuery) {
    const where = this.where(q);
    const [rows, total, counts] = await Promise.all([
      prisma.address.findMany({ where, ...paging(q), orderBy: { updatedAt: "desc" }, include: { customer: { select: { firstName: true, lastName: true, email: true } } } }),
      prisma.address.count({ where }),
      Promise.all([
        prisma.address.count(), prisma.address.count({ where: { type: "shipping" } }), prisma.address.count({ where: { type: "billing" } }),
        prisma.address.count({ where: { type: "pickup" } }), prisma.address.count({ where: { flagged: true } }), prisma.address.count({ where: { verified: false } }),
      ]),
    ]);
    const [all, shipping, billing, pickup, flagged, unverified] = counts;
    return withMeta(rows.map(toAdmin), { ...pageMeta(q, total), tabs: { all, shipping, billing, pickup, flagged, unverified } });
  },

  async adminUpdate(id: string, patch: AddressPatch & { notes?: string | null }) {
    const before = await prisma.address.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Address");
    const after = await prisma.$transaction(async (tx) => {
      if (patch.isDefault) await clearDefault(tx, before.customerId, patch.type ?? before.type, id);
      return tx.address.update({ where: { id }, data: patch, include: { customer: { select: { firstName: true, lastName: true, email: true } } } });
    });
    return { before, after: toAdmin(after) };
  },

  async adminFlag(id: string, data: { verified?: boolean; flagged?: boolean }) {
    const after = await prisma.address.update({ where: { id }, data, include: { customer: { select: { firstName: true, lastName: true, email: true } } } });
    return toAdmin(after);
  },

  async adminDefault(id: string) {
    const a = await prisma.address.findUniqueOrThrow({ where: { id } });
    await this.setDefault(a.customerId, id);
    return { ok: true };
  },

  async adminRemove(id: string) {
    const a = await prisma.address.findUniqueOrThrow({ where: { id } });
    return this.remove(a.customerId, id);
  },

  async exportCsv(q: AdminAddressQuery) {
    const rows = await prisma.address.findMany({ where: this.where(q), orderBy: { updatedAt: "desc" }, take: 50_000, include: { customer: { select: { firstName: true, lastName: true, email: true } } } });
    return toCsv(rows.map(toAdmin), ["customerName", "customerEmail", "label", "type", "recipient", "phone", "line1", "line2", "city", "state", "country", "postalCode", "isDefault", "verified", "flagged", "ordersShipped"]);
  },
};
