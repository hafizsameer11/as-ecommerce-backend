/**
 * Mobile/PWA app configuration (settings group `app`), cookie consent records and the
 * web "download our app" offer (asl-web AppDownloadOffer).
 */
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SettingsOf } from "@/modules/platform/settings/settings.defaults";
import { mintCustomerCoupon } from "@/modules/loyalty/club/club.service";
import type { AppConfigPatch, ConsentBody } from "./app-config.schemas";

/** personal codes minted by the download offer start with this (also how "already claimed" is detected) */
export const DOWNLOAD_OFFER_PREFIX = "APPDL";

/** -1 / 0 / 1; missing parts count as 0 ("1.2" == "1.2.0") */
export function compareVersions(a: string, b: string) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const cleanVersion = (v: string | undefined) => {
  const m = v?.trim().match(/^v?(\d+(?:\.\d+){0,2})/);
  return m ? m[1] : null;
};

function toPublic(app: SettingsOf<"app">, clientVersion: string | null) {
  return {
    minSupportedVersion: app.minSupportedVersion,
    latestVersion: app.latestVersion,
    clientVersion,
    /** client older than minSupportedVersion → blocking "update the app" screen */
    updateRequired: clientVersion ? compareVersions(clientVersion, app.minSupportedVersion) < 0 : false,
    /** client older than latestVersion → soft "new version available" prompt */
    updateAvailable: clientVersion ? compareVersions(clientVersion, app.latestVersion) < 0 : false,
    storeUrls: { ios: app.iosStoreUrl, android: app.androidStoreUrl },
    onboarding: app.onboarding,
    splash: app.splash,
    homeSections: app.homeSections,
    features: app.features,
    downloadOffer: { enabled: app.downloadOffer.enabled, percent: app.downloadOffer.percent, label: app.downloadOffer.label },
  };
}

async function publicConfig(appVersionHeader?: string) {
  return toPublic(await settingsService.get("app"), cleanVersion(appVersionHeader));
}

async function adminConfig() {
  return settingsService.get("app");
}

async function updateConfig(patch: AppConfigPatch, by: string) {
  const cur = await settingsService.get("app");
  const next: Partial<SettingsOf<"app">> = { ...(patch as Partial<SettingsOf<"app">>) };
  // nested toggles merge instead of replacing the whole object
  if (patch.features) next.features = { ...cur.features, ...patch.features };
  if (patch.homeSections) next.homeSections = { ...cur.homeSections, ...patch.homeSections };
  if (patch.splash) next.splash = { ...cur.splash, ...patch.splash };
  if (patch.downloadOffer) next.downloadOffer = { ...cur.downloadOffer, ...patch.downloadOffer };
  const minV = next.minSupportedVersion ?? cur.minSupportedVersion;
  const latestV = next.latestVersion ?? cur.latestVersion;
  if (compareVersions(minV, latestV) > 0)
    throw ApiError.badRequest("VALIDATION_FAILED", "Minimum supported version can't be newer than the latest version.");
  return settingsService.update("app", next, by);
}

async function saveConsent(b: ConsentBody, customerId?: string) {
  const row = await prisma.consentRecord.create({
    data: { anonId: b.anonId, customerId: customerId ?? null, performance: b.choices.performance, functional: b.choices.functional, advertising: b.choices.advertising },
  });
  return {
    id: row.id,
    essential: true as const,
    performance: row.performance,
    functional: row.functional,
    advertising: row.advertising,
    savedAt: row.createdAt.toISOString(),
  };
}

const toOffer = (cc: { code: string; label: string; value: number; expiresAt: Date | null; usedAt: Date | null }, alreadyClaimed: boolean) => ({
  code: cc.code,
  label: cc.label,
  pct: cc.value,
  source: "promo" as const,
  expiresAt: cc.expiresAt,
  used: !!cc.usedAt,
  alreadyClaimed,
});

/** once per customer: a personal % code; a second claim returns the same code */
async function claimDownloadOffer(customerId: string) {
  const { downloadOffer } = await settingsService.get("app");
  const r = await prisma.$transaction(async (tx) => {
    // serialise concurrent claims by the same customer
    await tx.$queryRaw`SELECT id FROM \`Customer\` WHERE id = ${customerId} FOR UPDATE`;
    const existing = await tx.customerCoupon.findFirst({ where: { customerId, code: { startsWith: DOWNLOAD_OFFER_PREFIX } } });
    if (existing) return { cc: existing, minted: false };
    if (!downloadOffer.enabled) throw ApiError.badRequest("INVALID_STATE", "This offer has ended.");
    const cc = await mintCustomerCoupon(tx, customerId, {
      prefix: `${DOWNLOAD_OFFER_PREFIX}-`, label: downloadOffer.label, type: "percent", value: downloadOffer.percent, source: "promo", days: downloadOffer.validDays,
    });
    return { cc, minted: true };
  });
  if (r.minted) events.emit("coupon.minted", { customerId, code: r.cc.code });
  return toOffer(r.cc, !r.minted);
}

export const appConfigService = { publicConfig, adminConfig, updateConfig, saveConsent, claimDownloadOffer };
