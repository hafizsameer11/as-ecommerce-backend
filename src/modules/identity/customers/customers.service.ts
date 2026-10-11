/**
 * asl-admin /customers: list (tabs, search, sort), profile, status / tier / marketing,
 * notes, tags, wallet adjustments and "Delete customer" (anonymise, orders are kept).
 * Spend / orders / AOV come from CustomerStats (kept up to date by the orders module).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { toCsv } from "@/core/utils/csv";
import { formatNaira } from "@/core/utils/money";
import { accountService } from "@/modules/identity/account/account.service";
import { walletsService } from "@/modules/payments/wallets/wallets.service";
import { toAddress } from "@/modules/platform/addresses/addresses.service";
import { listInclude, toAdminOrderRow } from "@/modules/commerce/orders/orders.mapper";
import { CUSTOMER_TABS, type CustomerListQuery, type StatusBody, type TierBody, type WalletAdjustBody } from "./customers.schemas";
import { customerRowInclude, toAdminCustomerRow, toAdminNote } from "./customers.mapper";

const SORTS: Record<string, (d: "asc" | "desc") => Prisma.CustomerOrderByWithRelationInput> = {
  spend: (d) => ({ stats: { totalSpend: d } }),
  orders: (d) => ({ stats: { ordersCount: d } }),
  lastOrderAt: (d) => ({ stats: { lastOrderAt: { sort: d, nulls: "last" } } }),
  createdAt: (d) => ({ createdAt: d }),
};

function sortBy(sort?: string): Prisma.CustomerOrderByWithRelationInput[] {
  const key = sort?.replace(/^-/, "") ?? "";
  const fn = SORTS[key];
  if (!fn) return [{ createdAt: "desc" }, { id: "desc" }];
  return [fn(sort!.startsWith("-") ? "desc" : "asc"), { id: "desc" }];
}

/** filters shared by the list, its tab counts and the CSV export (tab not included) */
function baseWhere(q: Pick<CustomerListQuery, "q" | "tier">): Prisma.CustomerWhereInput {
  const words = (q.q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
  return {
    deletedAt: null,
    ...(q.tier ? { tier: q.tier } : {}),
    ...(words.length
      ? {
          AND: words.map((w) => ({
            OR: [{ firstName: { contains: w } }, { lastName: { contains: w } }, { email: { contains: w } }, { phone: { contains: w.replace(/^0/, "") } }],
          })),
        }
      : {}),
  };
}

const whereFor = (q: CustomerListQuery): Prisma.CustomerWhereInput => (q.tab === "all" ? baseWhere(q) : { ...baseWhere(q), status: q.tab });

/** live (not deleted) customer or 404 */
async function live(id: string) {
  const c = await prisma.customer.findFirst({ where: { id, deletedAt: null }, include: customerRowInclude });
  if (!c) throw ApiError.notFound("Customer");
  return c;
}

const row = async (id: string) => toAdminCustomerRow(await live(id));

export const customersService = {
  async list(q: CustomerListQuery) {
    const where = whereFor(q);
    const [rows, total, groups] = await Promise.all([
      prisma.customer.findMany({ where, include: customerRowInclude, orderBy: sortBy(q.sort), ...paging(q) }),
      prisma.customer.count({ where }),
      prisma.customer.groupBy({ by: ["status"], where: baseWhere(q), _count: { _all: true } }),
    ]);
    const tabs = Object.fromEntries(CUSTOMER_TABS.map((t) => [t, 0])) as Record<(typeof CUSTOMER_TABS)[number], number>;
    for (const g of groups) {
      tabs[g.status] = g._count._all;
      tabs.all += g._count._all;
    }
    return withMeta(rows.map(toAdminCustomerRow), { ...pageMeta(q, total), tabs });
  },

  async get(id: string) {
    const c = await prisma.customer.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...customerRowInclude,
        addresses: { orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] },
        notes: { orderBy: { createdAt: "desc" } },
        twoFactor: { select: { enabledAt: true } },
      },
    });
    if (!c) throw ApiError.notFound("Customer");
    const orders = await prisma.order.findMany({ where: { customerId: id }, include: listInclude, orderBy: { placedAt: "desc" }, take: 10 });
    return {
      ...toAdminCustomerRow(c),
      emailVerified: !!c.emailVerifiedAt,
      phoneVerified: !!c.phoneVerifiedAt,
      dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
      gender: c.gender,
      avatarUrl: c.avatarUrl,
      referralCode: c.referralCode,
      twoFactorEnabled: !!c.twoFactor?.enabledAt,
      lastLoginAt: c.lastLoginAt,
      stats: {
        orders: c.stats?.ordersCount ?? 0,
        concierge: c.stats?.conciergeCount ?? 0,
        spend: Number(c.stats?.totalSpend ?? 0),
        spend12m: Number(c.stats?.spend12m ?? 0),
        aov: c.stats?.aov ?? 0,
        lastOrderAt: c.stats?.lastOrderAt ?? null,
      },
      wallet: { balance: c.wallet?.balance ?? 0, held: c.wallet?.held ?? 0, frozen: c.wallet?.frozen ?? false },
      addresses: c.addresses.map((a) => ({ ...toAddress(a), verified: a.verified, flagged: a.flagged })),
      notes: c.notes.map(toAdminNote),
      recentOrders: orders.map(toAdminOrderRow),
    };
  },

  /** blocking signs the customer out of every device */
  async setStatus(id: string, b: StatusBody) {
    const before = await row(id);
    await prisma.$transaction(async (tx) => {
      await tx.customer.update({ where: { id }, data: { status: b.status } });
      if (b.status === "blocked") await tx.customerSession.updateMany({ where: { customerId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    return { before, after: await row(id) };
  },

  async setTier(id: string, b: TierBody) {
    const before = await row(id);
    await prisma.customer.update({ where: { id }, data: { tier: b.tier } });
    return { before, after: await row(id) };
  },

  async setMarketing(id: string, optIn: boolean) {
    await live(id);
    await prisma.customer.update({ where: { id }, data: { marketingOptIn: optIn } });
    return row(id);
  },

  async addNote(id: string, body: string, author: string) {
    await live(id);
    return toAdminNote(await prisma.customerNote.create({ data: { customerId: id, author, body } }));
  },

  async removeNote(id: string, noteId: string) {
    const note = await prisma.customerNote.findFirst({ where: { id: noteId, customerId: id } });
    if (!note) throw ApiError.notFound("Note");
    await prisma.customerNote.delete({ where: { id: noteId } });
    return toAdminNote(note);
  },

  async addTag(id: string, tag: string) {
    await live(id);
    await prisma.customerTag.upsert({ where: { customerId_tag: { customerId: id, tag } }, create: { customerId: id, tag }, update: {} });
    return (await row(id)).tags;
  },

  async removeTag(id: string, tag: string) {
    await live(id);
    await prisma.customerTag.deleteMany({ where: { customerId: id, tag: tag.toLowerCase() } });
    return (await row(id)).tags;
  },

  async adjustWallet(id: string, b: WalletAdjustBody, actor: string) {
    await live(id);
    const tx = await walletsService.adjust({ customerId: id, ...b }, actor);
    return { transaction: tx, walletBalance: tx.balanceAfter };
  },

  /** "Delete customer": personal data removed now, orders / ledger kept */
  async anonymise(id: string) {
    const c = await live(id);
    const wallet = c.wallet;
    if (wallet && (wallet.balance > 0 || wallet.held > 0))
      throw ApiError.conflict(
        "INVALID_STATE",
        `This customer still has ${formatNaira(wallet.balance + wallet.held)} in their wallet. Refund or adjust the balance before deleting the account.`,
        { walletBalance: wallet.balance, held: wallet.held },
      );
    const before = toAdminCustomerRow(c);
    await accountService.anonymise(id);
    return before;
  },

  async exportCsv(q: CustomerListQuery) {
    const rows = await prisma.customer.findMany({ where: whereFor(q), include: customerRowInclude, orderBy: sortBy(q.sort), take: 50_000 });
    const data = rows.map((c) => {
      const r = toAdminCustomerRow(c);
      return { ...r, tags: r.tags.join("; "), spend: r.spend / 100, aov: r.aov / 100, walletBalance: r.walletBalance / 100 };
    });
    return toCsv(
      data,
      ["id", "name", "email", "phone", "city", "country", "tier", "status", "orders", "concierge", "spend", "aov", "walletBalance", "lastOrderAt", "createdAt", "marketingOptIn", "tags"],
      ["ID", "Name", "Email", "Phone", "City", "Country", "Tier", "Status", "Orders", "Concierge", "Spend (NGN)", "AOV (NGN)", "Wallet (NGN)", "Last order", "Joined", "Marketing opt-in", "Tags"],
    );
  },
};
