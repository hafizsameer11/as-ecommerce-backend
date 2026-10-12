/**
 * customer.registered (with an active advocate's code) → Referral + the friend's welcome reward
 * order.paid → attach the friend's first qualifying order (the `referrals.qualify` job does the rest)
 */
import { events } from "@/core/events/bus";
import { logger } from "@/core/utils/logger";
import { referralsService } from "./referrals.service";

let registered = false;

export function registerReferralListeners() {
  if (registered) return;
  registered = true;
  events.on("customer.registered", async ({ customerId, referralCode }) => {
    if (!referralCode) return;
    await referralsService.onRegistered(customerId, referralCode).catch((err) => logger.error({ err, customerId }, "referrals: sign-up failed"));
  });
  events.on("order.paid", async ({ orderId }) => {
    await referralsService.onOrderPaid(orderId).catch((err) => logger.error({ err, orderId }, "referrals: order.paid failed"));
  });
}
