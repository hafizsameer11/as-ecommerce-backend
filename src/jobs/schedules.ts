import { scheduleRepeating } from "@/core/queue/queue";

/** Repeating jobs (BullMQ job schedulers). Only run by the worker process (needs Redis). */
export async function registerSchedules() {
  // unpaid orders give their stock back after `checkout.unpaidOrderMinutes`
  await scheduleRepeating("orders.expire-unpaid", 5 * 60_000);
  // idle bags → abandoned, recovery reminders (RecoveryRule), lost after 7 days
  await scheduleRepeating("carts.abandon-scan", 15 * 60_000);
  // provider settlements → payouts (finance.payoutDelayDays)
  await scheduleRepeating("payouts.sync", 24 * 3_600_000);
  // deleted accounts: personal data removed after `account.deletionGraceDays`
  await scheduleRepeating("accounts.purge", 24 * 3_600_000);
}
