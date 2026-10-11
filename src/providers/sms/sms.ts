import { logger } from "@/core/utils/logger";

export type SmsMessage = { to: string; body: string; channel?: "sms" | "whatsapp" };

export interface SmsProvider {
  send(msg: SmsMessage): Promise<void>;
}

/** Mock: logs the message. Swap for Termii / Africa's Talking / Twilio adapter later. */
class MockSmsProvider implements SmsProvider {
  outbox: SmsMessage[] = [];
  async send(msg: SmsMessage) {
    this.outbox.push(msg);
    logger.info({ to: msg.to, body: msg.body }, "sms (mock)");
  }
}

export const sms = new MockSmsProvider();
