/**
 * In-process domain events. Emit AFTER the transaction commits.
 * Listeners never block the HTTP response; failures are logged.
 */
import { logger } from "@/core/utils/logger";

export type DomainEvents = {
  "customer.registered": { customerId: string; referralCode?: string };
  "customer.login": { customerId: string };
  "order.placed": { orderId: string };
  "order.paid": { orderId: string };
  "order.status_changed": { orderId: string; from: string; to: string };
  "order.cancelled": { orderId: string };
  "order.refunded": { orderId: string; amount: number };
  "order.shipped": { orderId: string; shipmentId: string };
  "order.delivered": { orderId: string };
  "pickup.ready": { bookingId: string };
  "return.updated": { returnId: string; status: string };
  "wallet.posted": { txId: string };
  "payout.paid": { payoutId: string };
  "payment.succeeded": { paymentId: string };
  "payment.failed": { paymentId: string };
  "review.published": { reviewId: string };
  "stock.low": { variantId: string; sku: string; available: number };
  "concierge.requested": { requestId: string };
  "concierge.status_changed": { requestId: string; to: string };
  "concierge.quoted": { quoteId: string };
  "ticket.created": { ticketId: string };
  "ticket.replied": { ticketId: string; by: "customer" | "agent" };
  "wallet.changed": { customerId: string };
  "coupon.minted": { customerId: string; code: string };
};
type Name = keyof DomainEvents;
type Listener<N extends Name> = (payload: DomainEvents[N]) => Promise<void> | void;

class EventBus {
  private listeners = new Map<Name, Listener<any>[]>();
  private pending = new Set<Promise<void>>();

  on<N extends Name>(name: N, fn: Listener<N>) {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }

  emit<N extends Name>(name: N, payload: DomainEvents[N]) {
    for (const fn of this.listeners.get(name) ?? []) {
      const p = Promise.resolve()
        .then(() => fn(payload))
        .catch((err) => logger.error({ err, event: name }, "event listener failed"))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  /** tests: wait for all running listeners */
  async flush() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

export const events = new EventBus();
