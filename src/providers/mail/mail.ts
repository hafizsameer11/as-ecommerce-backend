import nodemailer from "nodemailer";
import { env, isTest } from "@/config/env";
import { logger } from "@/core/utils/logger";

export type MailMessage = { to: string; subject: string; html: string; text?: string };

export interface MailProvider {
  send(msg: MailMessage): Promise<void>;
}

class SmtpProvider implements MailProvider {
  private transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: false,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  async send(msg: MailMessage) {
    await this.transport.sendMail({ from: env.MAIL_FROM, ...msg });
  }
}

/** Test/dev double: keeps messages in memory (tests read them to get OTPs / reset links). */
export class MemoryMailProvider implements MailProvider {
  outbox: MailMessage[] = [];
  async send(msg: MailMessage) {
    this.outbox.push(msg);
    logger.debug({ to: msg.to, subject: msg.subject }, "mail (memory)");
  }
}

export const mail: MailProvider & { outbox?: MailMessage[] } = isTest ? new MemoryMailProvider() : new SmtpProvider();
