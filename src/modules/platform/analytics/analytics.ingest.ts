/**
 * Storefront events (POST /store/events) → AnalyticsEvent rows.
 *
 * - Every event is validated on its own; junk is dropped, the batch never fails because of one bad event.
 * - Money is never taken from the client: `value` is only set on `purchase`, written by the server on order.paid.
 * - `source` holds the traffic group (direct | organic | social | paid | email | referral); the raw
 *   `utm_source/utm_medium` pair goes to `medium`, the campaign to `campaign`. A session keeps the first
 *   non-direct source it had, so later page views of that visit are attributed to the same source.
 */
import { prisma } from "@/core/db/prisma";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { clientEvent, type ClientEvent, type EventsBody, type TrafficSource } from "./analytics.schemas";
import { dayKey } from "./analytics.dates";

const SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|ask)\./i;
const SOCIAL = /(^|\.)(instagram|facebook|fb|tiktok|twitter|x|t|youtube|linkedin|snapchat|pinterest|whatsapp|wa|threads|reddit)\.(com|co|me|net)$|^(l|m|lm)\.facebook\.com$/i;
const SOCIAL_NAME = /^(instagram|ig|facebook|fb|meta|tiktok|twitter|x|youtube|yt|linkedin|snapchat|pinterest|whatsapp|threads|reddit)$/i;
const SEARCH_NAME = /^(google|bing|yahoo|duckduckgo|yandex|baidu)$/i;
const MAIL = /(^|\.)(mail\.google|outlook\.live|mail\.yahoo|outlook\.office)\./i;

const ownHosts = new Set(
  [env.WEB_URL, env.APP_URL, "https://asloriginals.com", "https://www.asloriginals.com"]
    .map((u) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

export function hostOf(url?: string | null) {
  if (!url) return null;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** traffic group from UTM tags / referrer */
export function classifySource(utm: ClientEvent["utm"], referrer?: string | null): TrafficSource {
  const src = utm?.source?.toLowerCase() ?? "";
  const med = utm?.medium?.toLowerCase() ?? "";
  if (/(cpc|ppc|paid|cpm|display|ads?$|sponsored|affiliate)/.test(med)) return "paid";
  if (/(email|e-mail|newsletter)/.test(med) || /(email|newsletter|campaign)/.test(src)) return "email";
  if (src) {
    if (SOCIAL_NAME.test(src) || /social/.test(med)) return "social";
    if (SEARCH_NAME.test(src)) return "organic";
    return "referral";
  }
  const host = hostOf(referrer);
  if (!host || ownHosts.has(host) || ownHosts.has(`www.${host}`)) return "direct";
  if (MAIL.test(host)) return "email";
  if (SEARCH.test(`${host}.`) || SEARCH.test(host)) return "organic";
  if (SOCIAL.test(host)) return "social";
  return "referral";
}

export function deviceFromUa(ua?: string) {
  if (!ua) return "desktop";
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android|IEMobile|Opera Mini/i.test(ua)) return "mobile";
  return "desktop";
}

const ID = /^[\w-]{8,64}$/;
const SESSION = /^[\w.:-]{4,64}$/;

export type IngestContext = { customerId?: string; anonId?: string; userAgent?: string; country?: string; channel?: string };

export const ingestService = {
  async record(body: EventsBody, ctx: IngestContext) {
    const batchAnon = ctx.anonId ?? (body.anonId && ID.test(body.anonId) ? body.anonId : undefined);
    const batchSession = body.sessionId && SESSION.test(body.sessionId) ? body.sessionId : undefined;
    const parsed: ClientEvent[] = [];
    for (const raw of body.events) {
      const r = clientEvent.safeParse(raw);
      if (r.success) parsed.push(r.data);
    }

    // product events need a real product (id or handle)
    const refs = [...new Set(parsed.map((e) => e.productId).filter(Boolean) as string[])];
    const products = refs.length
      ? await prisma.product.findMany({ where: { OR: [{ id: { in: refs } }, { handle: { in: refs } }] }, select: { id: true, handle: true } })
      : [];
    const productId = new Map<string, string>();
    for (const p of products) productId.set(p.id, p.id).set(p.handle, p.id);

    const today = dayKey();
    const rows = [];
    for (const e of parsed) {
      const anonId = batchAnon ?? e.anonId ?? (ctx.customerId ? `c_${ctx.customerId}` : undefined);
      if (!anonId) continue;
      const pid = e.productId ? productId.get(e.productId) : undefined;
      if ((e.name === "product_view" || e.name === "add_to_cart") && !pid) continue;
      if (e.name === "search" && !e.query) continue;
      const sessionId = (e.sessionId ?? batchSession ?? `${anonId}_${today}`).slice(0, 64);
      const utmPair = e.utm?.source || e.utm?.medium ? `${e.utm?.source ?? ""}/${e.utm?.medium ?? ""}`.slice(0, 190) : null;
      rows.push({
        anonId,
        customerId: ctx.customerId ?? null,
        sessionId,
        name: e.name,
        path: (e.name === "search" ? `/search?q=${encodeURIComponent(e.query!.toLowerCase())}` : (e.path ?? null))?.slice(0, 512) ?? null,
        productId: pid ?? null,
        value: null,
        device: e.device ?? deviceFromUa(ctx.userAgent),
        channel: e.channel ?? (ctx.channel && ["web", "mobile", "pwa"].includes(ctx.channel) ? ctx.channel : "web"),
        source: classifySource(e.utm, e.referrer) as string,
        medium: utmPair,
        campaign: e.utm?.campaign?.slice(0, 190) ?? null,
        referrer: e.referrer?.slice(0, 512) ?? null,
        country: (e.country ?? ctx.country)?.toUpperCase().slice(0, 2) ?? null,
      });
    }
    if (!rows.length) return { received: body.events.length, recorded: 0 };

    // a visit keeps its first non-direct source
    const sessions = [...new Set(rows.map((r) => r.sessionId))];
    const known = await prisma.analyticsEvent.findMany({
      where: { sessionId: { in: sessions }, source: { not: "direct" } },
      orderBy: { createdAt: "asc" },
      select: { sessionId: true, source: true, medium: true, campaign: true },
    });
    const sticky = new Map<string, { source: string | null; medium: string | null; campaign: string | null }>();
    for (const k of known) if (!sticky.has(k.sessionId)) sticky.set(k.sessionId, k);
    for (const r of rows) {
      const s = sticky.get(r.sessionId);
      if (r.source === "direct" && s) Object.assign(r, { source: s.source ?? "direct", medium: s.medium, campaign: s.campaign });
      else if (r.source !== "direct" && !s) sticky.set(r.sessionId, { source: r.source, medium: r.medium, campaign: r.campaign });
    }

    await prisma.analyticsEvent.createMany({ data: rows });
    return { received: body.events.length, recorded: rows.length };
  },

  /**
   * order.paid → one `purchase` event (server-side value). Attributed to the buyer's latest visit
   * (anon id, session, source, device) when the customer was seen by the event API; idempotent per order.
   */
  async recordPurchase(orderId: string) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, customerId: true, total: true, channel: true, paidAt: true, shippingAddress: true } });
    if (!o || !o.paidAt) return;
    const marker = `/orders/${o.number}`;
    if (await prisma.analyticsEvent.findFirst({ where: { name: "purchase", path: marker }, select: { id: true } })) return;
    const last = o.customerId
      ? await prisma.analyticsEvent.findFirst({
          where: { customerId: o.customerId, createdAt: { gte: new Date(o.paidAt.getTime() - 30 * 86_400_000) } },
          orderBy: { createdAt: "desc" },
        })
      : null;
    await prisma.analyticsEvent.create({
      data: {
        anonId: last?.anonId ?? (o.customerId ? `c_${o.customerId}` : `o_${o.id}`),
        customerId: o.customerId,
        sessionId: last?.sessionId ?? `order_${o.id}`.slice(0, 64),
        name: "purchase",
        path: marker,
        value: o.total,
        device: last?.device ?? (o.channel === "mobile" ? "mobile" : "desktop"),
        channel: o.channel === "mobile" || o.channel === "pwa" ? o.channel : "web",
        source: last?.source ?? "direct",
        medium: last?.medium ?? null,
        campaign: last?.campaign ?? null,
        country: last?.country ?? null,
        createdAt: o.paidAt,
      },
    });
    logger.debug({ order: o.number }, "analytics purchase recorded");
  },
};
