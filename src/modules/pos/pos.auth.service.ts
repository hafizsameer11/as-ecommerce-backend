import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { verifyPassword } from "@/core/auth/password";
import { adminAuthService } from "@/modules/identity/admin-auth/admin-auth.service";
import { POS_DISCOUNT_LIMITS } from "@/core/auth/permissions";
import type { SessionMeta } from "@/modules/identity/auth/session.service";
import type { PinLoginBody } from "./pos.schemas";

function locationIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(String) : [];
}

export const posAuthService = {
  async pinLogin(body: PinLoginBody, meta: SessionMeta) {
    const candidates = await prisma.adminUser.findMany({
      where: { status: "active", pinHash: { not: null } },
      select: { id: true, pinHash: true, role: true, name: true, email: true, locationIds: true },
    });
    let matched: (typeof candidates)[number] | null = null;
    for (const a of candidates) {
      if (a.pinHash && (await verifyPassword(a.pinHash, body.pin))) {
        matched = a;
        break;
      }
    }
    if (!matched) throw new ApiError(401, "INVALID_CREDENTIALS", "That PIN isn't right.");

    const locs = locationIds(matched.locationIds);
    if (body.registerId) {
      const reg = await prisma.posRegister.findUnique({ where: { id: body.registerId } });
      if (!reg || !reg.active) throw ApiError.notFound("Register");
      if (locs.length && !locs.includes(reg.locationId)) {
        throw ApiError.forbidden("You can't sign in on a till outside your boutiques.");
      }
    }

    const tokens = await adminAuthService.finish(matched.id, meta);
    const discountLimit =
      matched.role === "store_cashier" || matched.role === "store_supervisor" || matched.role === "store_manager"
        ? POS_DISCOUNT_LIMITS[matched.role]
        : matched.role === "super_admin" || matched.role === "ops_manager"
          ? 100
          : 0;

    return {
      ...tokens,
      staff: {
        ...tokens.admin,
        locationIds: locs,
        discountLimitPct: discountLimit,
      },
      registerId: body.registerId ?? null,
    };
  },
};
