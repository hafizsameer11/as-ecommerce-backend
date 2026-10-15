/**
 * Resolve demo image files for seeding.
 *
 * Look-up order:
 * 1. `prisma/seed/assets/...` (primary — shipped with this repo)
 * 2. `demo/seed-assets/...` (same files, tracked for discoverability)
 * 3. monorepo `../demo/seed-assets/...` when backend sits beside a root `demo/`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const seedDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(seedDir, "../..");

const ROOTS = [
  path.join(seedDir, "assets"),
  path.join(backendRoot, "demo/seed-assets"),
  // when asl-backend is nested in the monorepo: <root>/demo/seed-assets
  path.join(backendRoot, "../demo/seed-assets"),
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
