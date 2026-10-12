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
  // concierge: response-SLA levels (staff notified once per level), unpaid quotes past expiry
  await scheduleRepeating("concierge.sla-check", 15 * 60_000);
  await scheduleRepeating("concierge.expire-quotes", 15 * 60_000);
  // support tickets past their first-response SLA → staff alert once
  await scheduleRepeating("support.sla-check", 15 * 60_000);
  // ASL Club: rolling-spend tier review (downgrades happen here), points expiry, birthday bonus; referral qualification
  await scheduleRepeating("club.recompute-tiers", 24 * 3_600_000);
  await scheduleRepeating("club.expire-points", 24 * 3_600_000);
  await scheduleRepeating("club.birthday-bonus", 24 * 3_600_000);
  await scheduleRepeating("referrals.qualify", 6 * 3_600_000);
  // drops: upcoming → live at releaseAt (stock held, holders notified), live ↔ sold out; unpaid deposits / balances expire
  await scheduleRepeating("drops.release", 5 * 60_000);
  await scheduleRepeating("reservations.expire", 5 * 60_000);
  // marketing: due scheduled campaigns (→ sending → batches → sent) and push blasts
  await scheduleRepeating("campaigns.dispatch", 60_000);
  await scheduleRepeating("blasts.dispatch", 60_000);
}
