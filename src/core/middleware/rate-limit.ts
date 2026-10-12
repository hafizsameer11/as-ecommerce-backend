import rateLimit, { type Options, type Store } from "express-rate-limit";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { isTest } from "@/config/env";
import { getRedis, redisEnabled } from "@/core/db/redis";

/**
 * With REDIS_URL the counters live in Redis (shared by every API process behind the load balancer);
 * without it, in this process's memory. Skipped in tests.
 */
function store(name: string): Store | undefined {
  if (!redisEnabled) return undefined;
  return new LazyRedisStore(name);
}

/** connects on the first request, so scripts / the worker that import the routes don't open Redis for nothing */
class LazyRedisStore implements Store {
  private inner: RedisStore | null = null;
  private options: Options | null = null;
  readonly prefix: string;
  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }
  init(options: Options) {
    this.options = options;
  }
  private get s() {
    if (!this.inner) {
      const redis = getRedis()!;
      this.inner = new RedisStore({ prefix: this.prefix, sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply> });
      if (this.options) this.inner.init(this.options);
    }
    return this.inner;
  }
  get(key: string) {
    return this.s.get(key);
  }
  increment(key: string) {
    return this.s.increment(key);
  }
  decrement(key: string) {
    return this.s.decrement(key);
  }
  resetKey(key: string) {
    return this.s.resetKey(key);
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
    // Redis down → let requests through rather than taking the API down with it
    passOnStoreError: true,
    handler: (req, res) =>
      res.status(429).json({ error: { code: "RATE_LIMITED", message, requestId: req.id } }),
  });

export const authLimiter = base("auth", 60_000, 10, "Too many attempts. Please wait a minute and try again.");
export const otpLimiter = base("otp", 10 * 60_000, 5, "Too many codes requested. Please wait a few minutes.");
export const lookupLimiter = base("lookup", 60_000, 20, "Too many lookups. Please wait a minute.");
export const publicLimiter = base("public", 60_000, 300, "Too many requests. Please slow down.");
