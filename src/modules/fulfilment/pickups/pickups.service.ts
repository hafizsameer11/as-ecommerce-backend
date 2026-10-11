import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import type { LocationBody } from "./pickups.schemas";

const toStore = (l: { id: string; name: string; address: string; city: string; state: string; phone: string; hours: string; concierge: boolean }) => ({
  id: l.id, name: l.name, address: l.address, city: l.city, state: l.state, phone: l.phone, hours: l.hours, concierge: l.concierge,
});

export const pickupsService = {
  /** checkout "Pick up in store" + store locator */
  async storeLocations() {
    const rows = await prisma.pickupLocation.findMany({ where: { active: true }, orderBy: { name: "asc" } });
    return rows.map(toStore);
  },

  async activeLocation(id: string) {
    const l = await prisma.pickupLocation.findFirst({ where: { id, active: true } });
    if (!l) throw ApiError.badRequest("VALIDATION_FAILED", "That pick-up store is not available. Choose another one.");
    return l;
  },

  // ── admin /pickups → locations tab ──
  listLocations: () => prisma.pickupLocation.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { bookings: true } } } }),
  createLocation: (b: LocationBody) => prisma.pickupLocation.create({ data: b }),
  async updateLocation(id: string, b: Partial<LocationBody>) {
    const before = await prisma.pickupLocation.findUnique({ where: { id } });
    if (!before) throw ApiError.notFound("Pick-up location");
    return { before, after: await prisma.pickupLocation.update({ where: { id }, data: b }) };
  },
  async removeLocation(id: string) {
    const used = await prisma.order.count({ where: { pickupLocationId: id } });
    if (used) {
      // keep history intact: deactivate instead of deleting
      await prisma.pickupLocation.update({ where: { id }, data: { active: false } });
      return { deleted: false, deactivated: true };
    }
    await prisma.pickupLocation.delete({ where: { id } });
    return { deleted: true };
  },
};
