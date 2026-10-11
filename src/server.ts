import { createApp } from "./app";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { prisma } from "@/core/db/prisma";

const app = createApp();
const server = app.listen(env.PORT, () => logger.info(`ASL API listening on :${env.PORT}  (docs: ${env.APP_URL}/docs)`));

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
