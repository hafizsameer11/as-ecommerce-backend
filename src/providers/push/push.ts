import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";

export type PushMessage = { tokens: string[]; title: string; body: string; data?: Record<string, string> };

export interface PushProvider {
  send(msg: PushMessage): Promise<void>;
}

class MockPushProvider implements PushProvider {
  outbox: PushMessage[] = [];
  async send(msg: PushMessage) {
    this.outbox.push(msg);
    logger.info({ count: msg.tokens.length, title: msg.title }, "push (mock)");
  }
}

/** Expo push service (asl-mobile). */
class ExpoPushProvider implements PushProvider {
  async send(msg: PushMessage) {
    const chunks: string[][] = [];
    for (let i = 0; i < msg.tokens.length; i += 100) chunks.push(msg.tokens.slice(i, i + 100));
    for (const c of chunks) {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(c.map((to) => ({ to, title: msg.title, body: msg.body, data: msg.data, sound: "default" }))),
      });
      if (!res.ok) logger.warn({ status: res.status }, "expo push failed");
    }
  }
}

export const push: PushProvider = env.PUSH_PROVIDER === "expo" ? new ExpoPushProvider() : new MockPushProvider();
