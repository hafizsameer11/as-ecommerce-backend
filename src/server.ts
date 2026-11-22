import http from "node:http";
import { createApp } from "./app";
import { env, isProd } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { prisma } from "@/core/db/prisma";
import { closeRedis } from "@/core/db/redis";
import { closeQueue, flushInlineJobs } from "@/core/queue/queue";
import { markShuttingDown } from "@/core/http/ops";
import { attachRealtime, realtime } from "@/core/realtime/realtime.server";
import { adminAuthService } from "@/modules/identity/admin-auth/admin-auth.service";

const app = createApp();
const server = http.createServer(app);
// longer than a typical load balancer idle timeout (60 s), so the LB closes idle connections first
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
attachRealtime(server);
server.listen(env.PORT, () => {
  logger.info(`ASL API listening on :${env.PORT}  (docs: ${env.APP_URL}/docs, sockets: /socket.io)`);
  if (env.SEED_ADMIN_RESET) {
    void adminAuthService
      .ensureSeedAdmin()
      .then((r) =>
        logger.warn(
          { email: r.email },
          "SEED_ADMIN_RESET applied — set SEED_ADMIN_RESET=false after confirming admin login",
        ),
      )
      .catch((err) => logger.error({ err }, "SEED_ADMIN_RESET failed"));
  }
});
if (isProd && !env.METRICS_TOKEN) logger.warn("METRICS_TOKEN is not set: GET /metrics is public");

let stopping = false;
/**
 * SIGTERM / SIGINT: /ready turns 503 (load balancer stops sending traffic), the server stops accepting
 * connections and finishes in-flight requests, sockets close, then queue / Redis / database connections.
 */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  markShuttingDown();
  const force = setTimeout(() => {
    logger.error("shutdown took too long — exiting");
    process.exit(1);
  }, 25_000);
  force.unref();
  try {
    await realtime.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    await flushInlineJobs();
    await closeQueue();
    await closeRedis();
    await prisma.$disconnect();
    logger.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "shutdown failed");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));