/**
 * Prometheus metrics (GET /metrics). Each process has its own registry; scrape API and worker separately.
 */
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { isTest } from "@/config/env";

export const registry = new Registry();
if (!isTest) collectDefaultMetrics({ register: registry, prefix: "asl_" });

export const httpDuration = new Histogram({
  name: "asl_http_request_duration_seconds",
  help: "HTTP request duration by route template and status",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const jobRuns = new Counter({
  name: "asl_jobs_total",
  help: "Background jobs run by this process, by job name and outcome",
  labelNames: ["job", "outcome"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "asl_job_duration_seconds",
  help: "Background job duration",
  labelNames: ["job"] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
  registers: [registry],
});

/** wraps a job processor with run counters + duration */
export async function measureJob<T>(job: string, fn: () => Promise<T>) {
  const end = jobDuration.startTimer({ job });
  try {
    const out = await fn();
    jobRuns.inc({ job, outcome: "completed" });
    return out;
  } catch (err) {
    jobRuns.inc({ job, outcome: "failed" });
    throw err;
  } finally {
    end();
  }
}