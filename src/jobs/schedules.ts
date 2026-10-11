import { scheduleRepeating } from "@/core/queue/queue";

/** Repeating jobs (BullMQ job schedulers). Only run by the worker process (needs Redis). */
export async function registerSchedules() {
  // unpaid orders give their stock back after `checkout.unpaidOrderMinutes`
  await scheduleRepeating("orders.expire-unpaid", 5 * 60_000);
}
