import type { Ctx } from "@/core/http/router";
import { ApiError } from "@/core/http/errors";
import { campaignsService as svc } from "./campaigns.service";
import type { CampaignBody, CampaignListQuery, CampaignPatch, CampaignStatusBody, SendTestBody } from "./campaigns.schemas";

type Id = { id: string };
type Token = { token: string };

/** 1×1 transparent GIF */
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ASL ORIGINALS</title></head>
<body style="margin:0;background:#faf9f7;font-family:Helvetica,Arial,sans-serif;color:#0f0f0f">
<div style="max-width:480px;margin:80px auto;padding:32px 24px;text-align:center">
<div style="font-size:20px;letter-spacing:.2em;font-weight:700;margin-bottom:32px">ASL ORIGINALS</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1><p style="line-height:1.6;color:#444">${text}</p>
</div></body></html>`;

export const campaignsController = {
  list: ({ query }: Ctx<unknown, CampaignListQuery>) => svc.list(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  audience: ({ params }: Ctx<unknown, unknown, Id>) => svc.audience(params.id),
  create: async ({ body, admin, res }: Ctx<CampaignBody>) => {
    const c = await svc.create(body, admin);
    res.locals.audit = { entityId: c.id, after: c, summary: `Created campaign ${c.name}` };
    return c;
  },
  update: async ({ params, body, res }: Ctx<CampaignPatch, unknown, Id>) => {
    const r = await svc.update(params.id, body);
    res.locals.audit = { before: r.before, after: r.after, summary: `Edited campaign ${r.after.name}` };
    return r.after;
  },
  duplicate: async ({ params, admin, res }: Ctx<unknown, unknown, Id>) => {
    const c = await svc.duplicate(params.id, admin);
    res.locals.audit = { entityId: c.id, summary: `Duplicated campaign as ${c.name}` };
    return c;
  },
  togglePin: ({ params }: Ctx<unknown, unknown, Id>) => svc.togglePin(params.id),
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const r = await svc.remove(params.id);
    res.locals.audit = { summary: `Deleted campaign ${r.name}` };
    return { deleted: true };
  },
  setStatus: async ({ params, body, res }: Ctx<CampaignStatusBody, unknown, Id>) => {
    const r = await svc.setStatus(params.id, body);
    res.locals.audit = { before: { status: r.from }, after: { status: r.after.status, scheduledAt: r.after.scheduledAt }, summary: `Campaign ${r.after.name}: ${r.from} → ${r.after.status}` };
    return r.after;
  },
  sendTest: ({ params, body, admin }: Ctx<SendTestBody, unknown, Id>) => svc.sendTest(params.id, body, admin),
  sendNow: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const c = await svc.sendNow(params.id);
    res.locals.audit = { summary: `Sent campaign ${c.name} now` };
    return c;
  },

  // ── public tracking ──
  open: async ({ params, res }: Ctx<unknown, unknown, Token>) => {
    await svc.trackOpen(params.token).catch(() => undefined);
    res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", Pragma: "no-cache" });
    res.status(200).end(PIXEL);
  },
  click: async ({ params, query, res }: Ctx<unknown, { u?: string }, Token>) => {
    const target = await svc.trackClick(params.token, query.u);
    if (!target) throw ApiError.badRequest("VALIDATION_FAILED", "This link can't be opened.");
    res.set("Cache-Control", "no-store");
    res.redirect(302, target);
  },
  /** GET only shows a confirm button: email link scanners open links, and must not unsubscribe people */
  confirmUnsubscribe: ({ params, res }: Ctx<unknown, unknown, Token>) => {
    res.set("Cache-Control", "no-store");
    // the form posts back to this same URL; this page's CSP must allow it
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    res.status(200).type("html").send(
      page(
        "Unsubscribe from marketing?",
        `You'll stop receiving offers and news from ASL ORIGINALS. Order and account messages will still reach you.</p>
<form method="post" action="${esc(encodeURIComponent(params.token))}"><button style="margin-top:16px;padding:12px 28px;border:0;border-radius:4px;background:#0f0f0f;color:#fff;font-size:15px;cursor:pointer">Unsubscribe</button></form><p>`,
      ),
    );
  },
  unsubscribe: async ({ params, res }: Ctx<unknown, unknown, Token>) => {
    const r = await svc.unsubscribe(params.token);
    res.set("Cache-Control", "no-store");
    if (!r) return void res.status(404).type("html").send(page("Link not valid", "This unsubscribe link isn't valid any more. You can change your email preferences in your account settings."));
    res.status(200).type("html").send(
      page("You're unsubscribed", `${esc(r.email)} won't receive marketing emails or messages from ASL ORIGINALS any more. Order and account messages will still reach you. Changed your mind? Turn marketing back on in your account settings.`),
    );
  },
};
