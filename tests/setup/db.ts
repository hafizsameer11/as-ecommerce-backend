import { prisma } from "@/core/db/prisma";
import { seedReferenceData } from "../../prisma/seed/reference";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { clearPermissionCache } from "@/modules/identity/team/team.permissions";

let tables: string[] | null = null;

/** Empties every table and re-inserts reference data (tiers, zones, locales…). */
export async function resetDb() {
  if (!tables) {
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`;
    tables = rows.map((r) => r.name);
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of tables!) await tx.$executeRawUnsafe(`DELETE FROM \`${t}\``);
    await tx.$executeRawUnsafe("SET FOREIGN_KEY_CHECKS = 1");
  });
  settingsService.clearCache();
  clearPermissionCache();
  await seedReferenceData(prisma);
}
