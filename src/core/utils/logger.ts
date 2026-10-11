import pino from "pino";
import { env, isTest } from "@/config/env";

export const logger = pino({
  level: isTest ? "silent" : env.LOG_LEVEL,
  transport: env.NODE_ENV === "development" ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash"],
});
