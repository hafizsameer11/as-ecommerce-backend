/**
 * Journals for drop deposits (accounts: prisma/seed/reference.ts).
 *   deposit paid        Dr 1010 clearing          / Cr 2200 customer deposits
 *   balance paid        Dr 2200 customer deposits / Cr 1010 clearing   ← "applied"
 *       The order.paid journal (ledger.listeners) debits clearing for the whole amountPaid
 *       (deposit + balance) and credits sales/VAT. The deposit already hit clearing when it was
 *       paid, so this transfer takes it back out of clearing and empties 2200: net clearing =
 *       deposit + balance (what really came in), 2200 = 0, sales = full price. No double count.
 *   deposit refunded    Dr 2200 / Cr 1010 (card) or Cr 2000 (ASL Wallet)
 *   deposit forfeited   Dr 2200 / Cr 4800 other income (D4, `drops.depositRefundable` = false)
 * Each journal is posted once per reservation (postOnce by source + reference).
 * Called after commit; a failure is logged (the money movement itself already happened).
 */
import type { Payment } from "@/generated/prisma/client";
import { logger } from "@/core/utils/logger";
import { ledgerService, SYSTEM_USER } from "@/modules/payments/ledger/ledger.service";
import { ACC } from "@/modules/payments/ledger/ledger.listeners";

export const DEPOSITS = "2200";
export const OTHER_INCOME = "4800";

const cashAcc = (p: Pick<Payment, "provider">) => (p.provider === "manual" ? ACC.bank : ACC.clearing);

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    logger.error({ err }, `ledger: drop ${name} journal failed`);
  }
}

export const dropsLedger = {
  deposit: (number: string, p: Payment) =>
    safe("deposit", () =>
      ledgerService.postOnce("order", `${number}:deposit`, {
        date: p.paidAt ?? new Date(), description: `Drop deposit · ${number}`, createdBy: SYSTEM_USER,
        lines: [
          { accountCode: cashAcc(p), debit: p.amount, credit: 0, memo: `${p.provider} · ${p.reference}` },
          { accountCode: DEPOSITS, debit: 0, credit: p.amount, memo: "Customer deposit" },
        ],
      }),
    ),

  applied: (number: string, amount: number, orderNumber: string, p: Pick<Payment, "provider">) =>
    safe("applied", () =>
      amount > 0
        ? ledgerService.postOnce("order", `${number}:applied`, {
          date: new Date(), description: `Drop deposit applied to ${orderNumber} · ${number}`, createdBy: SYSTEM_USER,
          lines: [
            { accountCode: DEPOSITS, debit: amount, credit: 0, memo: "Deposit released" },
            { accountCode: cashAcc(p), debit: 0, credit: amount, memo: `Already counted in the ${orderNumber} journal` },
          ],
        })
        : Promise.resolve(null),
    ),

  refunded: (number: string, amount: number, to: "wallet" | "original", p: Pick<Payment, "provider">) =>
    safe("refund", () =>
      amount > 0
        ? ledgerService.postOnce("refund", `${number}:deposit`, {
          date: new Date(), description: `Drop deposit refunded · ${number}`, createdBy: SYSTEM_USER,
          lines: [
            { accountCode: DEPOSITS, debit: amount, credit: 0, memo: "Customer deposit" },
            { accountCode: to === "wallet" ? ACC.wallets : cashAcc(p), debit: 0, credit: amount, memo: to === "wallet" ? "Refund to ASL Wallet" : "Refund to original payment" },
          ],
        })
        : Promise.resolve(null),
    ),

  forfeited: (number: string, amount: number) =>
    safe("forfeit", () =>
      amount > 0
        ? ledgerService.postOnce("adjustment", `${number}:forfeit`, {
          date: new Date(), description: `Drop deposit forfeited · ${number}`, createdBy: SYSTEM_USER,
          lines: [
            { accountCode: DEPOSITS, debit: amount, credit: 0, memo: "Customer deposit" },
            { accountCode: OTHER_INCOME, debit: 0, credit: amount, memo: "Forfeited deposit (balance not paid)" },
          ],
        })
        : Promise.resolve(null),
    ),
};
