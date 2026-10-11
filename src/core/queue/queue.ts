/**
 * Background jobs. With REDIS_URL set, jobs go to BullMQ and run in the worker
 * process (`npm run dev:worker`). Without Redis (tests, quick local runs) they run
 * in-process right away, so features still work end-to-end.
 */
import { Queue, Worker, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { env, isTest } from "@/config/env";
import { logger } from "@/core/utils/logger";

type Processor = (data: any) => Promise<void>;
const processors = new Map<string, Processor>();
const QUEUE = "asl";

let connection: IORedis | null = null;
let queue: Queue | null = null;
const useRedis = Boolean(env.REDIS_URL) && !isTest;

function getQueue() {
  if (!useRedis) return null;
  if (!queue) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE, { connection });
  }
  return queue;
}

export function defineJob<T>(name: string, fn: (data: T) => Promise<void>) {
  processors.set(name, fn as Processor);
  return (data: T, opts?: JobsOptions) => enqueue(name, data, opts);
}

const inline = new Set<Promise<void>>();

export async function enqueue(name: string, data: unknown, opts?: JobsOptions) {
  const q = getQueue();
  if (q) {
    await q.add(name, data, { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: "exponential", delay: 5000 }, ...opts });
    return;
  }
  // inline mode: delayed jobs are skipped (they are covered by schedulers in the worker)
  if (opts?.delay && opts.delay > 0) return;
  const fn = processors.get(name);
  if (!fn) return logger.warn({ name }, "no processor for job");
  const p = fn(data)
    .catch((err) => logger.error({ err, name }, "inline job failed"))
    .finally(() => inline.delete(p));
  inline.add(p);
}

export async function flushInlineJobs() {
  while (inline.size) await Promise.all([...inline]);
}

export function startWorker() {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is required to run the worker");
  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(
    QUEUE,
    async (job) => {
      const fn = processors.get(job.name);
      if (!fn) throw new Error(`No processor for ${job.name}`);
      await fn(job.data);
    },
    { connection: conn, concurrency: 8 },
  );
  worker.on("failed", (job, err) => logger.error({ err, job: job?.name }, "job failed"));
  return worker;
}

export async function scheduleRepeating(name: string, everyMs: number) {
  const q = getQueue();
  if (!q) return;
  await q.upsertJobScheduler(`repeat:${name}`, { every: everyMs }, { name, data: {} });
}
