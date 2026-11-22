import rateLimit, { MemoryStore, type Options, type Store } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { isTest } from "@/config/env";
import { getRedis, redisEnabled } from "@/core/db/redis";

/**
 * With REDIS_URL the counters live in Redis (shared by every API process behind the load balancer);
 * on Redis errors, fall back to in-process memory. Without Redis, memory only. Skipped in tests.
 */
function store(name: string): Store | undefined {
  if (!redisEnabled) return undefined;
  return new LazyRedisStore(name);
}

/** connects on the first request, so scripts / the worker that import the routes don't open Redis for nothing */
class LazyRedisStore implements Store {
  private redis: RedisStore | null = null;
  private memory = new MemoryStore();
  private options: Options | null = null;
  private useMemory = false;
  readonly prefix: string;
  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }
  init(options: Options) {
    this.options = options;
    this.memory.init(options);
  }
  private redisStore() {
    if (!this.redis) {
      const client = getRedis()!;
      this.redis = new RedisStore({
        prefix: this.prefix,
        sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as Promise<RedisReply>,
      });
      if (this.options) this.redis.init(this.options);
    }
    return this.redis;
  }
  private async call<T>(redisFn: () => Promise<T>, memFn: () => Promise<T>) {
    if (this.useMemory) return memFn();
    try {
      return await redisFn();
    } catch {
      this.useMemory = true;
      return memFn();
    }
  }
  get(key: string) {
    return this.call(() => this.redisStore().get(key), () => this.memory.get(key));
  }
  increment(key: string) {
    return this.call(() => this.redisStore().increment(key), () => this.memory.increment(key));
  }
  decrement(key: string) {
    return this.call(() => this.redisStore().decrement(key), () => this.memory.decrement(key));
  }
  resetKey(key: string) {
    return this.call(() => this.redisStore().resetKey(key), () => this.memory.resetKey(key));
  }
}

const base = (name: string, windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => isTest,
    store: store(name),
    handler: (req, res) =>
      res.status(429).json({ error: { code: "RATE_LIMITED", message, requestId: req.id } }),
  });

export const authLimiter = base("auth", 60_000, 10, "Too many attempts. Please wait a minute and try again.");
export const otpLimiter = base("otp", 10 * 60_000, 5, "Too many codes requested. Please wait a few minutes.");
export const lookupLimiter = base("lookup", 60_000, 20, "Too many lookups. Please wait a minute.");
export const publicLimiter = base("public", 60_000, 300, "Too many requests. Please slow down.");