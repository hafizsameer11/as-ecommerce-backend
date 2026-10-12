/**
 * Prometheus metrics (GET /metrics on the API, and on the worker when WORKER_METRICS_PORT is set).
 * Each process has its own registry; Prometheus scrapes both and sums them.
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

export const paymentOutcomes = new Counter({
  name: "asl_payments_total",
  help: "Payments settled, by purpose and outcome (succeeded | failed | amount_mismatch)",
  labelNames: ["purpose", "outcome"] as const,
  registers: [registry],
});

export const refundOutcomes = new Counter({
  name: "asl_refunds_total",
  help: "Gateway refund sends, by outcome (processed | pending | retry | failed | webhook_processed | webhook_failed)",
  labelNames: ["outcome"] as const,
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
