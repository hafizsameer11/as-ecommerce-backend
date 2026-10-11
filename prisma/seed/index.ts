import { prisma } from "../../src/core/db/prisma";
import { hashPassword } from "../../src/core/auth/password";
import { seedReferenceData } from "./reference";
import { seedCatalog } from "./catalog";

async function main() {
  await seedReferenceData(prisma);
  console.log("reference data ✓");

  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@asloriginals.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  await prisma.adminUser.upsert({
    where: { email },
    create: { email, name: "ASL Admin", role: "super_admin", status: "active", passwordHash: await hashPassword(password) },
    update: {},
  });
  console.log(`admin ✓  ${email} / ${password}  (change it after first login)`);

  await seedCatalog(prisma);

  // demo customer used across the prototype screens
  const demo = "john.doe@example.com";
  if (!(await prisma.customer.findUnique({ where: { email: demo } }))) {
    const c = await prisma.customer.create({
      data: {
        email: demo, firstName: "John", lastName: "Doe", phone: "8012345678", phoneCountry: "NG", tier: "Gold",
        passwordHash: await hashPassword("Password123!"), referralCode: "JOHN-ASL10", hasOnboarded: true, emailVerifiedAt: new Date(),
        wallet: { create: {} }, stats: { create: {} },
        notificationPref: { create: { channels: { push: true, email: true, sms: false }, topics: { orders: true, concierge: true, shipping: true, promos: false, wishlist: true } } },
      },
    });
    await prisma.advocate.create({ data: { customerId: c.id, code: "JOHN-ASL10" } });
    console.log(`demo customer ✓  ${demo} / Password123!`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
