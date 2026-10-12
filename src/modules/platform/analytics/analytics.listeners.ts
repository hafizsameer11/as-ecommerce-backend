/**
 * order.paid → server-side `purchase` analytics event (the client never reports purchases or money).
 * Also references the rollup jobs so their processors are registered in the worker.
 */
import { events } from "@/core/events/bus";
import { logger } from "@/core/utils/logger";
import { ingestService } from "./analytics.ingest";
import { analyticsRollupJob, analyticsRollupNightlyJob } from "./analytics.rollups";

let registered = false;

export function registerAnalyticsListeners() {
  if (registered) return;
  registered = true;
  events.on("order.paid", async ({ orderId }: { orderId: string }) => {
    try {
      await ingestService.recordPurchase(orderId);
    } catch (err) {
      logger.error({ err, orderId }, "analytics: purchase event failed");
    }
  });
  return [analyticsRollupJob, analyticsRollupNightlyJob];
}
