import { startWorker } from "@/core/queue/queue";
import { registerListeners } from "@/modules";
import { registerSchedules } from "@/jobs/schedules";
import { logger } from "@/core/utils/logger";

await registerListeners();
startWorker();
await registerSchedules();
logger.info("ASL worker started");
