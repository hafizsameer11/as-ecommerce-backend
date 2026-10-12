/**
 * Shared by pages, FAQs and blog:
 *  - `cleanHtml` — server-side HTML allow-list for rich text (CMS editors paste HTML; the apps render it).
 *  - template tokens — `{{returns.windowDays}}` etc. are rendered from settings / shipping zones at
 *    request time, so policy copy never goes stale when an admin changes a business rule (DECISIONS U1, U3).
 *  - slug + status helpers.
 */
import sanitizeHtml from "sanitize-html";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { PUBLIC_GROUPS, type SettingsGroup } from "@/modules/platform/settings/settings.defaults";

/* ── HTML allow-list ─────────────────────────────────────────────────── */

const HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "small", "sup", "sub", "span", "a",
    "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "code", "pre",
    "table", "thead", "tbody", "tr", "th", "td", "img", "figure", "figcaption",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target === "_blank" ? { ...attribs, rel: "noopener noreferrer" } : attribs,
    }),
  },
};

/** Rich text → safe HTML (scripts, styles, event handlers, javascript: links and iframes are removed). */
export const cleanHtml = (html: string) => sanitizeHtml(html, HTML_OPTIONS).trim();

/** Plain-text fields (titles, labels): no markup at all. */
export const cleanText = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/** Markdown-ish blog bodies are kept as written; anything that looks like HTML goes through the allow-list. */
export const cleanRich = (s: string) => (/<[a-z!/][^>]*>/i.test(s) ? cleanHtml(s) : s);

/* ── slugs ───────────────────────────────────────────────────────────── */

/** "/Customer-Care/Return-Policy/" → "customer-care/return-policy" */
export const normalizeSlug = (s: string) =>
  s.trim().toLowerCase().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 120) || "untitled";

/** first free "<slug>-copy", "<slug>-copy-2" … */
export async function freeSlug(base: string, exists: (slug: string) => Promise<boolean>) {
  let slug = base;
  for (let i = 2; await exists(slug); i++) slug = `${base}-${i}`;
  return slug;
}

/* ── status ──────────────────────────────────────────────────────────── */

export type ContentStatusName = "draft" | "scheduled" | "published" | "archived";

/** fields to write for a status change (pages + blog posts) */
export function statusFields(status: ContentStatusName, scheduledFor: Date | null | undefined, current: { publishedAt: Date | null }) {
  if (status === "scheduled") {
    if (!scheduledFor) throw ApiError.badRequest("VALIDATION_FAILED", "Pick a date and time to publish.", [{ path: "scheduledFor", message: "Required" }]);
    if (scheduledFor.getTime() <= Date.now()) throw ApiError.badRequest("VALIDATION_FAILED", "The publish time must be in the future.", [{ path: "scheduledFor", message: "Must be in the future" }]);
    return { status, scheduledFor };
  }
  if (status === "published") return { status, scheduledFor: null, publishedAt: current.publishedAt ?? new Date() };
  return { status, scheduledFor: null };
}

/* ── template tokens ─────────────────────────────────────────────────── */

const naira = (kobo: number) => `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
/** settings keys that hold kobo amounts → rendered as "₦150,000" */
const MONEY_KEYS = new Set([
  "freeShippingThreshold", "serviceFee", "shippingEstimate", "minTopup", "maxTopup", "minWithdrawal", "minOrderValue", "maxOrderValue",
]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type TokenValue = { text: string; html: string };
export type TokenContext = Map<string, TokenValue>;

function flatten(prefix: string, v: unknown, out: TokenContext) {
  if (v == null) return;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string" || typeof x === "number")) {
      const text = v.map((x) => String(x).replace(/-/g, " ")).join(", ");
      out.set(prefix, { text, html: esc(text) });
    }
    return;
  }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(`${prefix}.${k}`, x, out);
    return;
  }
  const key = prefix.split(".").pop()!;
  const text = typeof v === "number" && MONEY_KEYS.has(key) ? naira(v) : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  out.set(prefix, { text, html: esc(text) });
}

const table = (head: [string, string], rows: [string, string][]) =>
  `<table><thead><tr><th>${esc(head[0])}</th><th>${esc(head[1])}</th></tr></thead><tbody>${rows
    .map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`)
    .join("")}</tbody></table>`;

/**
 * Every value a CMS editor may reference. Scalars of the public settings groups are available as
 * `{{group.key}}` (nested: `{{concierge.responseSlaHours.standard}}`), plus computed tokens:
 *   {{shipping.deliveryTimesTable}} {{shipping.deliveryFeesTable}} {{shipping.deliveryTimesText}} {{shipping.deliveryFeesText}}
 *   {{profile.serviceHoursText}} {{payments.methods}} {{returns.returnShippingPayer}}
 */
export async function tokenContext(): Promise<TokenContext> {
  // no extra cache here: settingsService caches (and is cleared on PATCH), zones + methods are two small queries
  const ctx: TokenContext = new Map();
  const groups: SettingsGroup[] = [...PUBLIC_GROUPS, "support"];
  for (const g of groups) flatten(g, await settingsService.get(g), ctx);

  const [zones, methods] = await Promise.all([
    prisma.shippingZone.findMany({
      where: { active: true },
      orderBy: { priority: "asc" },
      include: { rates: { where: { active: true }, orderBy: { position: "asc" } } },
    }),
    prisma.paymentMethodSetting.findMany({ where: { enabled: true }, orderBy: { position: "asc" } }),
  ]);
  const withRate = zones.filter((z) => z.rates.length);
  const times = withRate.map((z) => [z.name, z.rates[0].etaDays] as [string, string]);
  const fees = withRate.map((z) => {
    const r = z.rates[0];
    const base = r.perKgFee ? `from ${naira(r.baseFee)}` : naira(r.baseFee);
    return [z.name, r.freeAbove != null ? `${base} · free over ${naira(r.freeAbove)}` : base] as [string, string];
  });
  ctx.set("shipping.deliveryTimesTable", { text: times.map(([a, b]) => `${a}: ${b}`).join(" · "), html: table(["Location", "Estimated Delivery Time"], times) });
  ctx.set("shipping.deliveryFeesTable", { text: fees.map(([a, b]) => `${a}: ${b}`).join(" · "), html: table(["Location", "Delivery Fee"], fees) });
  const timesText = times.map(([a, b]) => `${a}: ${b.charAt(0).toLowerCase()}${b.slice(1)}`).join(". ");
  ctx.set("shipping.deliveryTimesText", { text: timesText, html: esc(timesText) });
  const feesText = fees.map(([a, b]) => `${a}: ${b}`).join(". ");
  ctx.set("shipping.deliveryFeesText", { text: feesText, html: esc(feesText) });

  const profile = await settingsService.get("profile");
  const hours = profile.serviceHours.map((h) => `${h.days}: ${h.hours}`).join(" · ");
  ctx.set("profile.serviceHoursText", { text: hours, html: esc(hours) });

  const pm = methods.map((m) => m.label).join(", ");
  ctx.set("payments.methods", { text: pm, html: esc(pm) });

  const returns = await settingsService.get("returns");
  const payer = returns.returnShippingPaidBy === "store" ? "covered by ASL ORIGINALS" : "covered by the customer";
  ctx.set("returns.returnShippingPayer", { text: payer, html: esc(payer) });

  return ctx;
}

const TOKEN_RE = /\{\{\s*([a-zA-Z][\w.]*)\s*\}\}/g;

/** Replace tokens. Unknown tokens are left visible so an editor notices them in preview. */
export function renderTokens(s: string, ctx: TokenContext, mode: "html" | "text") {
  if (!s.includes("{{")) return s;
  return s.replace(TOKEN_RE, (m, key: string) => {
    const v = ctx.get(key);
    return v ? v[mode] : m;
  });
}

/** tokens in a string that the context doesn't know (SEO audit / preview warnings) */
export const unknownTokens = (s: string, ctx: TokenContext) => [...s.matchAll(TOKEN_RE)].map((m) => m[1]).filter((k) => !ctx.has(k));

/** admin "insert value" list */
export async function tokenList() {
  const ctx = await tokenContext();
  return [...ctx.entries()].map(([key, v]) => ({ token: `{{${key}}}`, value: v.text }));
}

/** absolute or /uploads URLs inside an HTML / markdown body (media usage tracking) */
export function urlsIn(s: string | null | undefined): string[] {
  if (!s) return [];
  const out = new Set<string>();
  for (const m of s.matchAll(/(?:src|href)="([^"]+)"/g)) out.add(m[1]);
  for (const m of s.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) out.add(m[1]);
  return [...out];
}
