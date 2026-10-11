import type { AccountType, JournalEntry, JournalLine, LedgerAccount } from "@/generated/prisma/client";

/** same wording / normal side as asl-admin ledger-store */
export const ACCOUNT_TYPE_META: Record<AccountType, { label: string; normal: "debit" | "credit" }> = {
  asset: { label: "Asset", normal: "debit" },
  liability: { label: "Liability", normal: "credit" },
  equity: { label: "Equity", normal: "credit" },
  revenue: { label: "Revenue", normal: "credit" },
  expense: { label: "Expense", normal: "debit" },
};

export const SOURCE_LABEL = {
  order: "Order", refund: "Refund", payout: "Payout", fee: "Processor fee",
  adjustment: "Adjustment", tax: "Tax", wallet: "Wallet", manual: "Manual",
} as const;

export const STATUS_LABEL = { posted: "Posted", draft: "Draft", void: "Void" } as const;

/** balance signed by the account's normal side (asset/expense: debit − credit) */
export const signedBalance = (type: AccountType, debit: number, credit: number) =>
  ACCOUNT_TYPE_META[type].normal === "debit" ? debit - credit : credit - debit;

export const toAccount = (a: LedgerAccount, sums?: { debit: number; credit: number }) => {
  const debit = sums?.debit ?? 0;
  const credit = sums?.credit ?? 0;
  return {
    code: a.code, name: a.name, type: a.type, typeLabel: ACCOUNT_TYPE_META[a.type].label, normal: ACCOUNT_TYPE_META[a.type].normal,
    currency: a.currency, archived: a.archived, debit, credit, balance: signedBalance(a.type, debit, credit),
  };
};

type EntryWithLines = JournalEntry & { lines: (JournalLine & { account?: { name: string } | null })[] };

export const toEntry = (e: EntryWithLines) => {
  const lines = e.lines.map((l) => ({
    id: l.id, accountCode: l.accountCode, accountName: l.account?.name ?? null, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo,
  }));
  const debit = lines.reduce((n, l) => n + l.debit, 0);
  const credit = lines.reduce((n, l) => n + l.credit, 0);
  return {
    id: e.id, number: e.number, date: e.date, reference: e.reference, description: e.description,
    source: e.source, sourceLabel: SOURCE_LABEL[e.source], status: e.status, statusLabel: STATUS_LABEL[e.status],
    createdBy: e.createdBy, createdAt: e.createdAt, updatedAt: e.updatedAt,
    lines, totals: { debit, credit, balanced: debit === credit },
  };
};
