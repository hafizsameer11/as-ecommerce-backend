/**
 * Reset (or create) the seed super-admin password.
 * Usage: npm run db:reset-admin
 * Env: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD (defaults match .env.example)
 */
import { prisma } from "../src/core/db/prisma";
import { hashPassword } from "../src/core/auth/password";

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@asloriginals.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const passwordHash = await hashPassword(password);

  await prisma.adminUser.upsert({
    where: { email },
    create: {
      email,
      name: "ASL Admin",
      role: "super_admin",
      status: "active",
      passwordHash,
    },
    update: {
      passwordHash,
      status: "active",
      role: "super_admin",
    },
  });

  // Drop old sessions so a fresh login is required
  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email } });
  await prisma.adminSession.updateMany({
    where: { adminId: admin.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  console.log(`Reset admin: ${email}`);
  console.log(`Password:   ${password}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
