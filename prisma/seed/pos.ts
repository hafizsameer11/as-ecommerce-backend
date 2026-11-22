import type { PrismaClient } from "../../src/generated/prisma/client";
import { hashPassword } from "../../src/core/auth/password";

/** Boutique warehouses + tills + sample PINs (Temi 1234, Chidi 2468, Halima 1111). */
export async function seedPos(prisma: PrismaClient) {
  const locations = await prisma.pickupLocation.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 3 });
  if (!locations.length) {
    console.log("pos seed skipped (no pickup locations)");
    return;
  }

  for (const loc of locations) {
    const code = `POS-${loc.id.slice(-4).toUpperCase()}`;
    const wh = await prisma.warehouse.upsert({
      where: { code },
      create: { name: `${loc.name} stock`, code, city: loc.city, active: true, pickupLocationId: loc.id },
      update: { pickupLocationId: loc.id, active: true },
    });
    const existing = await prisma.posRegister.findFirst({ where: { locationId: loc.id, name: "Till 1" } });
    if (!existing) {
      await prisma.posRegister.create({
        data: {
          locationId: loc.id,
          warehouseId: wh.id,
          name: "Till 1",
          device: "iPad",
          terminalId: `TERM-${code}`,
          scanner: "USB",
        },
      });
    }
  }

  const locationIds = locations.map((l) => l.id);
  const staff: { email: string; name: string; role: "store_manager" | "store_supervisor" | "store_cashier"; pin: string }[] = [
    { email: "temi.pos@asloriginals.com", name: "Temi Adebayo", role: "store_manager", pin: "1234" },
    { email: "chidi.pos@asloriginals.com", name: "Chidi Okonkwo", role: "store_supervisor", pin: "2468" },
    { email: "halima.pos@asloriginals.com", name: "Halima Bello", role: "store_cashier", pin: "1111" },
  ];
  for (const s of staff) {
    const pinHash = await hashPassword(s.pin);
    await prisma.adminUser.upsert({
      where: { email: s.email },
      create: {
        email: s.email,
        name: s.name,
        role: s.role,
        status: "active",
        passwordHash: await hashPassword("ChangeMe123!"),
        pinHash,
        locationIds,
      },
      update: { pinHash, locationIds, status: "active", role: s.role },
    });
  }
  const promoCount = await prisma.posPromotion.count();
  if (!promoCount) {
    const now = new Date();
    const ends = new Date(now.getTime() + 365 * 86_400_000);
    await prisma.posPromotion.createMany({
      data: [
        {
          name: "Buy 2 get 1",
          label: "Buy 2 get 1 free",
          kind: "bxgy",
          buy: 2,
          get: 1,
          value: 0,
          scope: { type: "all" },
          channels: ["pos", "store"],
          stores: [],
          startsAt: now,
          endsAt: ends,
          active: true,
        },
        {
          name: "Spend 100k save 10k",
          label: "₦10k off over ₦100k",
          kind: "spend",
          value: 1_000_000,
          minSpend: 10_000_000,
          scope: { type: "all" },
          channels: ["pos", "store"],
          stores: [],
          startsAt: now,
          endsAt: ends,
          active: true,
        },
        {
          name: "Birthday 10%",
          label: "Birthday 10% off",
          kind: "birthday",
          value: 10,
          scope: { type: "all" },
          channels: ["pos", "store"],
          stores: [],
          startsAt: now,
          endsAt: ends,
          active: true,
        },
      ],
    });
  }

  console.log("pos ✓  tills + PIN staff (Temi 1234 / Chidi 2468 / Halima 1111) + sample promos");
}
