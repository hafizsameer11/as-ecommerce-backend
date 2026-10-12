import type { Prisma } from "@/generated/prisma/client";
import { fullName } from "@/modules/identity/auth/customer.mapper";

export const customerRowInclude = {
  stats: true,
  wallet: { select: { balance: true, held: true, frozen: true } },
  tags: { select: { tag: true }, orderBy: { tag: "asc" } },
} satisfies Prisma.CustomerInclude;
export type CustomerListRow = Prisma.CustomerGetPayload<{ include: typeof customerRowInclude }>;

const regions = new Intl.DisplayNames(["en"], { type: "region" });
export const countryName = (code: string | null) => {
  if (!code) return "";
  try {
    return regions.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
};

/** one row of asl-admin /customers (the UI `Customer` type, money in kobo) */
export function toAdminCustomerRow(c: CustomerListRow, loyaltyPoints = 0) {
  return {
    id: c.id,
    name: fullName(c),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone ?? "",
    city: c.city ?? "",
    country: countryName(c.country),
    countryCode: c.country,
    tier: c.tier,
    status: c.status,
    orders: c.stats?.ordersCount ?? 0,
    concierge: c.stats?.conciergeCount ?? 0,
    spend: Number(c.stats?.totalSpend ?? 0),
    aov: c.stats?.aov ?? 0,
    walletBalance: c.wallet?.balance ?? 0,
    // available ASL Club points (loyalty/club points.service)
    loyaltyPoints,
    lastOrderAt: c.stats?.lastOrderAt ?? null,
    createdAt: c.createdAt,
    marketingOptIn: c.marketingOptIn,
    tags: c.tags.map((t) => t.tag),
  };
}

export const toAdminNote = (n: { id: string; author: string; body: string; createdAt: Date }) => ({ id: n.id, author: n.author, at: n.createdAt, body: n.body });
