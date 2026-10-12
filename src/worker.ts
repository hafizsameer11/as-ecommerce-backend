import http from "node:http";
import { closeQueue, startWorker } from "@/core/queue/queue";
import { registerListeners } from "@/modules";
import { registerSchedules } from "@/jobs/schedules";
import { logger } from "@/core/utils/logger";
import { attachEmitter, realtime } from "@/core/realtime/realtime";
import { env } from "@/config/env";
import { prisma } from "@/core/db/prisma";
import { closeRedis } from "@/core/db/redis";
import { renderMetrics } from "@/core/http/ops";

// listeners running here (jobs: payouts sync, SLA checks …) reach the API's sockets through Redis
attachEmitter();
await registerListeners();
startWorker();
await registerSchedules();
logger.info("ASL worker started");

// job counters / durations of this process for Prometheus (the API's /metrics only sees its own process)
let metricsServer: http.Server | null = null;
if (env.WORKER_METRICS_PORT) {
  metricsServer = http.createServer((req, res) => {
    if (req.url === "/metrics")
      return void renderMetrics(req.headers.authorization).then((out) => {
        res.writeHead(out.status, { "Content-Type": out.contentType, "Cache-Control": "no-store" });
        res.end(out.body);
      });
    if (req.url === "/health") return void res.end("ok");
    res.statusCode = 404;
    res.end();
  });
  metricsServer.listen(env.WORKER_METRICS_PORT, () => logger.info(`worker metrics on :${env.WORKER_METRICS_PORT}/metrics`));
}

let stopping = false;
/** SIGTERM / SIGINT: running jobs finish (BullMQ hands the rest to another worker), then connections close */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker shutting down");
  setTimeout(() => process.exit(1), 60_000).unref();
  await closeQueue();
  metricsServer?.close();
  await realtime.close();
  await closeRedis();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
