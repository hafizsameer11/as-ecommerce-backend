import { prisma } from "@/core/db/prisma";
import { mail, type MailAttachment } from "@/providers/mail/mail";
import { sms } from "@/providers/sms/sms";
import { push } from "@/providers/push/push";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { DEFAULT_TEMPLATES } from "./templates.defaults";
import { logger } from "@/core/utils/logger";

export type Channel = "email" | "sms" | "push" | "whatsapp";
export type Vars = Record<string, string | number | undefined | null>;

export const fill = (s: string, vars: Vars) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
/** {{variables}} used by a template's texts, in order of appearance */
export const templateVariables = (...texts: (string | null | undefined)[]) =>
  [...new Set(texts.flatMap((t) => [...(t ?? "").matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])))];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function template(code: string, channel: Channel) {
  const row = await prisma.messageTemplate.findUnique({ where: { code_channel: { code, channel } } });
  if (row) return row.status === "active" ? row : null;
  return DEFAULT_TEMPLATES.find((t) => t.code === code && t.channel === channel) ?? null;
}

async function render(code: string, channel: Channel, vars: Vars) {
  const t = await template(code, channel);
  if (!t) return null;
  return {
    subject: fill(t.subject ?? "", vars),
    preheader: "preheader" in t && t.preheader ? fill(t.preheader, vars) : undefined,
    body: fill(t.body, vars),
    ctaLabel: t.ctaLabel ?? undefined,
    link: t.linkTo ? fill(t.linkTo, vars) : undefined,
  };
}

type EmailExtras = { preheader?: string; /** trusted HTML appended under the footer (tracking pixel, unsubscribe link) */ footerHtml?: string };

async function emailHtml(subject: string, body: string, ctaLabel?: string, link?: string, extras: EmailExtras = {}) {
  const brand = await settingsService.get("brand");
  const profile = await settingsService.get("profile");
  const paragraphs = esc(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.6">${p.replace(/\n/g, "<br>")}</p>`).join("");
  const cta = ctaLabel && link
    ? `<p style="margin:24px 0"><a href="${esc(link)}" style="background:${brand.ink};color:#fff;padding:12px 22px;border-radius:4px;text-decoration:none;font-weight:600">${esc(ctaLabel)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:${brand.bg};font-family:Inter Tight,Helvetica,Arial,sans-serif;color:${brand.ink}">
${extras.preheader ? `<div style="display:none;max-height:0;overflow:hidden">${esc(extras.preheader)}</div>` : ""}<div style="max-width:560px;margin:0 auto;padding:32px 24px">
<div style="font-size:20px;letter-spacing:.2em;font-weight:700;margin-bottom:24px">${esc(profile.displayName)}</div>
<h1 style="font-size:18px;margin:0 0 16px">${esc(subject)}</h1>${paragraphs}${cta}
<p style="margin-top:32px;font-size:12px;color:#777">${esc(profile.address)} · ${esc(profile.supportEmail)}</p>${extras.footerHtml ?? ""}
</div></body></html>`;
}

/** Fire-and-forget delivery used by every module. Missing / paused templates are skipped. */
export const messaging = {
  render,
  async email(to: string, code: string, vars: Vars, attachments?: MailAttachment[]) {
    const r = await render(code, "email", vars);
    if (!r) return;
    try {
      await mail.send({ to, subject: r.subject, text: r.body, html: await emailHtml(r.subject, r.body, r.ctaLabel, r.link, { preheader: r.preheader }), attachments });
      await prisma.messageTemplate.updateMany({ where: { code, channel: "email" }, data: { sentCount: { increment: 1 } } });
    } catch (err) {
      logger.error({ err, code }, "email failed");
    }
  },
  async sms(to: string, code: string, vars: Vars) {
    const r = await render(code, "sms", vars);
    if (!r) return;
    await sms.send({ to, body: r.body }).catch((err) => logger.error({ err, code }, "sms failed"));
  },
  async push(customerId: string, code: string, vars: Vars, data?: Record<string, string>) {
    const r = await render(code, "push", vars);
    if (!r) return;
    const tokens = await prisma.pushToken.findMany({ where: { customerId }, select: { token: true } });
    if (!tokens.length) return;
    await push.send({ tokens: tokens.map((t) => t.token), title: r.subject || "ASL ORIGINALS", body: r.body, data }).catch((err) =>
      logger.error({ err, code }, "push failed"),
    );
  },
  emailHtml,
};
