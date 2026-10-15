/**
 * Keep prisma/seed/assets ↔ repo-root demo/seed-assets in sync (WebP product/merch images).
 *
 *   npm run db:seed:sync-assets           # seed → demo (default, for GitHub)
 *   npm run db:seed:sync-assets -- --pull # demo → seed
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const seedDir = path.dirname(fileURLToPath(import.meta.url));
const seedAssets = path.join(seedDir, "assets");
const demoAssets = path.join(seedDir, "../../../demo/seed-assets");
const pull = process.argv.includes("--pull");

function copyTree(from: string, to: string) {
  if (!fs.existsSync(from)) throw new Error(`Missing source: ${from}`);
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      n += copyTree(src, dest);
    } else {
      fs.copyFileSync(src, dest);
      n++;
    }
  }
  return n;
}

const from = pull ? demoAssets : seedAssets;
const to = pull ? seedAssets : demoAssets;
const count = copyTree(from, to);
console.log(`synced ${count} files\n  ${from}\n→ ${to}`);
