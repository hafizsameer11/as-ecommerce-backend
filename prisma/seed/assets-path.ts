/**
 * Resolve demo image files for seeding.
 *
 * Look-up order:
 * 1. `prisma/seed/assets/...` (shipped with asl-backend)
 * 2. monorepo `demo/seed-assets/...` (tracked at repo root for GitHub)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const seedDir = path.dirname(fileURLToPath(import.meta.url));

const ROOTS = [
  path.join(seedDir, "assets"),
  // prisma/seed → prisma → asl-backend → repo root
  path.join(seedDir, "../../../demo/seed-assets"),
];

/** Absolute path to a seed image (e.g. `p-sneaker.webp` or `merch/hero-bag.webp`). */
export function resolveSeedAsset(relPath: string): string {
  const normalized = relPath.replace(/^[/\\]+/, "");
  for (const root of ROOTS) {
    const full = path.join(root, normalized);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(
    `Seed asset not found: ${normalized}\nSearched:\n${ROOTS.map((r) => `  - ${path.join(r, normalized)}`).join("\n")}`,
  );
}

export function readSeedAsset(relPath: string): Buffer {
  return fs.readFileSync(resolveSeedAsset(relPath));
}
