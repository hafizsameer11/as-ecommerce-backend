/**
 * Background jobs. With REDIS_URL set, jobs go to BullMQ and run in the worker
 * process (`npm run dev:worker`). Without Redis (tests, quick local runs) they run
 * in-process right away, so features still work end-to-end.
 */
import { Queue, Worker, type JobsOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { getRedis, redisEnabled } from "@/core/db/redis";
import { measureJob } from "@/core/metrics/metrics";

type Processor = (data: any) => Promise<void>;
const processors = new Map<string, Processor>();
const QUEUE = "asl";

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue() {
  const connection = getRedis();
  if (!connection) return null;
  queue ??= new Queue(QUEUE, { connection });
  return queue;
}

/** true when jobs run in this process right away (no Redis: tests, quick local runs) */
export const jobsRunInline = () => !redisEnabled;

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
  const p = measureJob(name, () => fn(data))
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
  worker = new Worker(
    QUEUE,
    async (job) => {
      const fn = processors.get(job.name);
      if (!fn) throw new Error(`No processor for ${job.name}`);
      await measureJob(job.name, () => fn(job.data));
    },
    { connection: conn, concurrency: 8 },
  );
  worker.on("failed", (job, err) => logger.error({ err, job: job?.name }, "job failed"));
  return worker;
}

/** waiting / active / delayed / failed … counts in Redis (null without Redis) — for /metrics */
export async function queueCounts() {
  const q = getQueue();
  if (!q) return null;
  return q.getJobCounts("waiting", "active", "delayed", "failed", "completed");
}

/** graceful shutdown: let running jobs finish, then close the queue connections */
export async function closeQueue() {
  if (worker) await worker.close().catch((err) => logger.error({ err }, "worker close failed"));
  worker = null;
  if (queue) await queue.close().catch(() => undefined);
  queue = null;
}

export async function scheduleRepeating(name: string, everyMs: number) {
  const q = getQueue();
  if (!q) return;
  await q.upsertJobScheduler(`repeat:${name}`, { every: everyMs }, { name, data: {} });
}
