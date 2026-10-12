/**
 * ASL Club reacts to orders and lifecycle events:
 *   order.paid               → earn points (current tier's multiplier), then upgrade the tier if the spend crossed a threshold
 *   order.refunded/cancelled → take back the refunded share of the order's points
 *   customer.registered      → welcome bonus · review.published → review bonus
 */
import { events } from "@/core/events/bus";
import { logger } from "@/core/utils/logger";
import { clubService } from "./club.service";

let registered = false;

export function registerClubListeners() {
  if (registered) return;
  registered = true;
  const safe = <T>(name: string, fn: (p: T) => Promise<unknown>) => async (p: T) => {
    try {
      await fn(p);
    } catch (err) {
      logger.error({ err, payload: p }, `club: ${name} failed`);
    }
  };

  events.on("order.paid", safe("order.paid", ({ orderId }: { orderId: string }) => clubService.onOrderPaid(orderId)));
  events.on("order.refunded", safe("order.refunded", ({ orderId }: { orderId: string }) => clubService.reverseForOrder(orderId)));
  events.on("order.cancelled", safe("order.cancelled", ({ orderId }: { orderId: string }) => clubService.reverseForOrder(orderId)));
  events.on("customer.registered", safe("customer.registered", ({ customerId }: { customerId: string }) => clubService.signupBonus(customerId)));
  events.on("review.published", safe("review.published", ({ reviewId }: { reviewId: string }) => clubService.reviewBonus(reviewId)));
}
