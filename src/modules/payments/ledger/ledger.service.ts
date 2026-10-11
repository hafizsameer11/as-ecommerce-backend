/**
 * Double-entry ledger. Every journal must balance (Σ debit = Σ credit, to the kobo) and each line
 * sits on one side only. Automatic journals come from ledger.listeners.ts; finance books manual ones.
 * Only `posted` entries count in balances; `void` entries stay for the audit trail.
 */
import type { JournalSource, JournalStatus, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { toCsv } from "@/core/utils/csv";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { signedBalance, SOURCE_LABEL, toAccount, toEntry } from "./ledger.mapper";
import type { AccountBody, AccountsQuery, EntriesQuery, EntryBody, EntryPatch, LineInput, PeriodQuery } from "./ledger.schemas";

export const SYSTEM_USER = "system";

export type PostInput = {
  date?: Date;
  reference?: string | null;
  description: string;
  source: JournalSource;
  lines: LineInput[];
  createdBy: string;
  status?: Exclude<JournalStatus, "void">;
};

const lineInclude = { lines: { include: { account: { select: { name: true } } } } } as const;

type CleanLine = { accountCode: string; debit: number; credit: number; memo: string | null };

/** validates lines (one side each, > 0, accounts exist and are open) and returns them cleaned */
async function checkLines(db: Tx | typeof prisma, lines: LineInput[]): Promise<CleanLine[]> {
  if (lines.length < 2) throw ApiError.badRequest("VALIDATION_FAILED", "A journal needs at least two lines.");
  const clean = lines.map((l, i) => {
    const debit = l.debit ?? 0;
    const credit = l.credit ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0)
      throw ApiError.badRequest("VALIDATION_FAILED", `Line ${i + 1}: amounts must be whole kobo and not negative.`, { line: i });
    if ((debit > 0) === (credit > 0))
      throw ApiError.badRequest("VALIDATION_FAILED", `Line ${i + 1}: enter either a debit or a credit.`, { line: i });
    return { accountCode: l.accountCode, debit, credit, memo: l.memo ?? null };
  });
  const debit = clean.reduce((n, l) => n + l.debit, 0);
  const credit = clean.reduce((n, l) => n + l.credit, 0);
  if (debit !== credit)
    throw ApiError.badRequest("VALIDATION_FAILED", "Debits and credits must be equal.", { debit, credit, difference: debit - credit });
  const codes = [...new Set(clean.map((l) => l.accountCode))];
  const accounts = await db.ledgerAccount.findMany({ where: { code: { in: codes } } });
  const missing = codes.filter((c) => !accounts.some((a) => a.code === c));
  if (missing.length) throw ApiError.badRequest("VALIDATION_FAILED", `Unknown account ${missing.join(", ")}.`, { accounts: missing });
  const archived = accounts.filter((a) => a.archived).map((a) => a.code);
  if (archived.length) throw ApiError.badRequest("VALIDATION_FAILED", `Account ${archived.join(", ")} is archived.`, { accounts: archived });
  return clean;
}

async function create(tx: Tx, i: PostInput) {
  const lines = await checkLines(tx, i.lines);
  const number = formatters.journal(await nextSequence(tx, "journal", 20241));
  return tx.journalEntry.create({
    data: {
      number, date: i.date ?? new Date(), reference: i.reference ?? null, description: i.description, source: i.source,
      status: i.status ?? "posted", createdBy: i.createdBy,
      lines: { create: lines.map((l) => ({ accountCode: l.accountCode, debit: BigInt(l.debit), credit: BigInt(l.credit), memo: l.memo })) },
    },
    include: lineInclude,
  });
}

/** post a journal (inside the caller's transaction, or its own) */
async function post(i: PostInput, tx?: Tx) {
  return tx ? create(tx, i) : prisma.$transaction((t) => create(t, i));
}

/** automatic journals: post once per (source, reference); a second event for the same thing is a no-op */
async function postOnce(source: JournalSource, reference: string, i: Omit<PostInput, "source" | "reference">, tx?: Tx) {
  const run = async (t: Tx) => {
    const exists = await t.journalEntry.findFirst({ where: { reference, source }, select: { id: true } });
    if (exists) return null;
    return create(t, { ...i, source, reference });
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

/** Σ debit / credit per account over posted entries */
async function sums(period: { from?: Date; to?: Date } = {}) {
  const rows = await prisma.journalLine.groupBy({
    by: ["accountCode"],
    where: { entry: { status: "posted", ...(period.from || period.to ? { date: { ...(period.from ? { gte: period.from } : {}), ...(period.to ? { lte: period.to } : {}) } } : {}) } },
    _sum: { debit: true, credit: true },
  });
  return new Map(rows.map((r) => [r.accountCode, { debit: Number(r._sum.debit ?? 0), credit: Number(r._sum.credit ?? 0) }]));
}

async function findEntry(idOrNumber: string) {
  const e = await prisma.journalEntry.findFirst({ where: idOrNumber.startsWith("JE-") ? { number: idOrNumber } : { id: idOrNumber }, include: lineInclude });
  if (!e) throw ApiError.notFound("Journal entry");
  return e;
}

function entriesWhere(q: Omit<EntriesQuery, "page" | "pageSize" | "sort">): Prisma.JournalEntryWhereInput {
  return {
    ...(q.source ? { source: q.source } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.account ? { lines: { some: { accountCode: q.account } } } : {}),
    ...(q.from || q.to ? { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    ...(q.q ? { OR: [{ number: { contains: q.q } }, { reference: { contains: q.q } }, { description: { contains: q.q } }] } : {}),
  };
}

export const ledgerService = {
  post,
  postOnce,

  // ── accounts ──
  async accounts(q: AccountsQuery) {
    const [accounts, s] = await Promise.all([
      prisma.ledgerAccount.findMany({ where: q.includeArchived ? {} : { archived: false }, orderBy: { code: "asc" } }),
      sums(q),
    ]);
    return accounts.map((a) => toAccount(a, s.get(a.code)));
  },

  async addAccount(b: AccountBody) {
    if (await prisma.ledgerAccount.findUnique({ where: { code: b.code } }))
      throw ApiError.conflict("CONFLICT", `Account ${b.code} already exists.`);
    return toAccount(await prisma.ledgerAccount.create({ data: { code: b.code, name: b.name, type: b.type } }));
  },

  async renameAccount(code: string, name: string) {
    const a = await prisma.ledgerAccount.findUnique({ where: { code } });
    if (!a) throw ApiError.notFound("Account");
    return toAccount(await prisma.ledgerAccount.update({ where: { code }, data: { name } }));
  },

  async setArchived(code: string, archived: boolean) {
    const a = await prisma.ledgerAccount.findUnique({ where: { code } });
    if (!a) throw ApiError.notFound("Account");
    return toAccount(await prisma.ledgerAccount.update({ where: { code }, data: { archived } }));
  },

  // ── entries ──
  async entries(q: EntriesQuery) {
    const where = entriesWhere(q);
    const { status: _s, ...noStatus } = q;
    const tabWhere = entriesWhere(noStatus);
    const [rows, total, byStatus] = await Promise.all([
      prisma.journalEntry.findMany({ where, ...paging(q), orderBy: [{ date: "desc" }, { createdAt: "desc" }], include: lineInclude }),
      prisma.journalEntry.count({ where }),
      prisma.journalEntry.groupBy({ by: ["status"], where: tabWhere, _count: { _all: true } }),
    ]);
    const count = (s: JournalStatus) => byStatus.find((b) => b.status === s)?._count._all ?? 0;
    return withMeta(rows.map(toEntry), {
      ...pageMeta(q, total),
      tabs: { all: count("posted") + count("draft") + count("void"), posted: count("posted"), draft: count("draft"), void: count("void") },
    });
  },

  async get(idOrNumber: string) {
    return toEntry(await findEntry(idOrNumber));
  },

  async createManual(b: EntryBody, createdBy: string) {
    return toEntry(await post({ ...b, createdBy }));
  },

  async updateDraft(idOrNumber: string, b: EntryPatch) {
    const e = await findEntry(idOrNumber);
    if (e.status !== "draft") throw ApiError.conflict("INVALID_STATE", "Only draft entries can be edited. Void it and book a correcting entry instead.");
    const updated = await prisma.$transaction(async (tx) => {
      if (b.lines) {
        const lines = await checkLines(tx, b.lines);
        await tx.journalLine.deleteMany({ where: { entryId: e.id } });
        await tx.journalLine.createMany({ data: lines.map((l) => ({ entryId: e.id, accountCode: l.accountCode, debit: BigInt(l.debit), credit: BigInt(l.credit), memo: l.memo })) });
      }
      return tx.journalEntry.update({
        where: { id: e.id },
        data: {
          ...(b.date ? { date: b.date } : {}),
          ...(b.reference !== undefined ? { reference: b.reference } : {}),
          ...(b.description ? { description: b.description } : {}),
          ...(b.source ? { source: b.source } : {}),
        },
        include: lineInclude,
      });
    });
    return { before: toEntry(e), after: toEntry(updated) };
  },

  async postDraft(idOrNumber: string) {
    const e = await findEntry(idOrNumber);
    if (e.status !== "draft") throw ApiError.conflict("INVALID_STATE", "Only draft entries can be posted.");
    // re-check: accounts may have been archived since the draft was saved
    await checkLines(prisma, e.lines.map((l) => ({ accountCode: l.accountCode, debit: Number(l.debit), credit: Number(l.credit) })));
    return toEntry(await prisma.journalEntry.update({ where: { id: e.id }, data: { status: "posted" }, include: lineInclude }));
  },

  async void(idOrNumber: string) {
    const e = await findEntry(idOrNumber);
    if (e.status === "void") throw ApiError.conflict("INVALID_STATE", "This entry is already void.");
    return toEntry(await prisma.journalEntry.update({ where: { id: e.id }, data: { status: "void" }, include: lineInclude }));
  },

  async removeDraft(idOrNumber: string) {
    const e = await findEntry(idOrNumber);
    if (e.status !== "draft") throw ApiError.conflict("INVALID_STATE", "Only drafts can be deleted. Void posted entries instead.");
    await prisma.journalEntry.delete({ where: { id: e.id } });
    return { deleted: true };
  },

  async exportEntries(q: Omit<EntriesQuery, "page" | "pageSize">) {
    const rows = await prisma.journalEntry.findMany({ where: entriesWhere(q), orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 50_000, include: lineInclude });
    // one row per journal line (what accountants import)
    const flat = rows.flatMap((e) =>
      e.lines.map((l) => ({
        number: e.number, date: e.date, reference: e.reference ?? "", description: e.description, source: SOURCE_LABEL[e.source], status: e.status,
        accountCode: l.accountCode, accountName: l.account?.name ?? "", debit: Number(l.debit) / 100, credit: Number(l.credit) / 100, memo: l.memo ?? "", createdBy: e.createdBy,
      })),
    );
    return toCsv(
      flat,
      ["number", "date", "reference", "description", "source", "status", "accountCode", "accountName", "debit", "credit", "memo", "createdBy"],
      ["Entry", "Date", "Reference", "Description", "Source", "Status", "Account", "Account name", "Debit (NGN)", "Credit (NGN)", "Memo", "Created by"],
    );
  },

  // ── reports ──
  async trialBalance(q: PeriodQuery) {
    const [accounts, s] = await Promise.all([prisma.ledgerAccount.findMany({ orderBy: { code: "asc" } }), sums(q)]);
    const rows = accounts
      .filter((a) => !a.archived || s.has(a.code))
      .map((a) => {
        const { debit, credit } = s.get(a.code) ?? { debit: 0, credit: 0 };
        const net = debit - credit;
        return {
          code: a.code, name: a.name, type: a.type, debit, credit, balance: signedBalance(a.type, debit, credit),
          /** trial-balance columns */
          debitBalance: net > 0 ? net : 0,
          creditBalance: net < 0 ? -net : 0,
        };
      });
    const totals = {
      debit: rows.reduce((n, r) => n + r.debit, 0),
      credit: rows.reduce((n, r) => n + r.credit, 0),
      debitBalance: rows.reduce((n, r) => n + r.debitBalance, 0),
      creditBalance: rows.reduce((n, r) => n + r.creditBalance, 0),
    };
    return { from: q.from ?? null, to: q.to ?? null, rows, totals: { ...totals, balanced: totals.debitBalance === totals.creditBalance } };
  },

  async exportTrialBalance(q: PeriodQuery) {
    const tb = await this.trialBalance(q);
    return toCsv(
      [...tb.rows, { code: "", name: "Total", type: "", debitBalance: tb.totals.debitBalance, creditBalance: tb.totals.creditBalance }].map((r) => ({
        ...r, debitBalance: r.debitBalance / 100, creditBalance: r.creditBalance / 100,
      })),
      ["code", "name", "type", "debitBalance", "creditBalance"],
      ["Account", "Name", "Type", "Debit (NGN)", "Credit (NGN)"],
    );
  },
};
