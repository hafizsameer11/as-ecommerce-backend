import { startWorker } from "@/core/queue/queue";
import { registerListeners } from "@/modules";
import { registerSchedules } from "@/jobs/schedules";
import { logger } from "@/core/utils/logger";
import { attachEmitter } from "@/core/realtime/realtime";

// listeners running here (jobs: payouts sync, SLA checks …) reach the API's sockets through Redis
attachEmitter();
await registerListeners();
startWorker();
await registerSchedules();
logger.info("ASL worker started");
