import { z } from "zod";
import { patchOf } from "@/core/http/patch-schema";
import { settingsSchemas } from "@/modules/platform/settings/settings.defaults";

const semver = z.string().trim().regex(/^\d+(\.\d+){0,2}$/, "Use a version like 1.4.0");

/** PATCH /admin/app/config — any subset of the `app` settings group; nested toggles are merged */
export const appConfigPatch = patchOf(
  settingsSchemas.app.extend({
    minSupportedVersion: semver,
    latestVersion: semver,
    splash: settingsSchemas.app.shape.splash.partial(),
    downloadOffer: settingsSchemas.app.shape.downloadOffer.partial(),
  }),
);

/** web cookie banner (asl-web cookie-consent.ts): essential is always on */
export const consentBody = z.object({
  anonId: z.string().trim().min(1).max(64),
  choices: z.object({
    performance: z.boolean().default(false),
    functional: z.boolean().default(false),
    advertising: z.boolean().default(false),
  }),
});

export type AppConfigPatch = z.infer<typeof appConfigPatch>;
export type ConsentBody = z.infer<typeof consentBody>;
