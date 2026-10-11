import { prisma, type Db } from "@/core/db/prisma";

/**
 * Gap-free counters for human references (ASL-ORD-10248, RET-2210 …).
 * Must run inside a transaction so the row lock is held until commit.
 */
export async function nextSequence(db: Db, key: string, start: number): Promise<number> {
  const run = async (tx: Db) => {
    await tx.$executeRaw`INSERT INTO \`Sequence\` (\`key\`, \`value\`) VALUES (${key}, ${start}) ON DUPLICATE KEY UPDATE \`value\` = \`value\` + 1`;
    const rows = await tx.$queryRaw<{ value: number | bigint }[]>`SELECT \`value\` FROM \`Sequence\` WHERE \`key\` = ${key}`;
    return Number(rows[0].value);
  };
  if ("$transaction" in db) return (db as typeof prisma).$transaction((tx) => run(tx));
  return run(db);
}

export const formatters = {
  order: (n: number) => `ASL-ORD-${n}`,
  return: (n: number) => `RET-${n}`,
  draft: (n: number) => `DFT-${n}`,
  concierge: (n: number) => `ASL${n}`,
  quote: (n: number) => `QT-${n}`,
  ticket: (n: number) => `#${n}`,
  shipment: (n: number) => `SHP-${n}`,
  pickup: (n: number) => `PU-${n}`,
  payout: (n: number) => `PO-${n}`,
  journal: (n: number) => `JE-${n}`,
  reservation: (n: number) => `RSV-${n}`,
};
