/**
 * One shared ioredis connection per process (queue producer, rate limits, readiness check).
 * Null without REDIS_URL, and always null in tests (jobs inline, memory rate limits).
 * BullMQ workers and socket.io pub/sub keep their own connections (blocking / subscriber mode).
 */
import IORedis from "ioredis";
import { env, isTest } from "@/config/env";

let client: IORedis | null = null;

export const redisEnabled = Boolean(env.REDIS_URL) && !isTest;

export function getRedis(): IORedis | null {
  if (!redisEnabled) return null;
  client ??= new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return client;
}

export async function closeRedis() {
  if (!client) return;
  const c = client;
  client = null;
  await c.quit().catch(() => c.disconnect());
}
