import http from "node:http";
import { createApp } from "./app";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { prisma } from "@/core/db/prisma";
import { attachRealtime, realtime } from "@/core/realtime/realtime.server";

const app = createApp();
const server = http.createServer(app);
attachRealtime(server);
server.listen(env.PORT, () => logger.info(`ASL API listening on :${env.PORT}  (docs: ${env.APP_URL}/docs, sockets: /socket.io)`));

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  setTimeout(() => process.exit(1), 10_000).unref();
  // closes the sockets and the HTTP server
  await realtime.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
