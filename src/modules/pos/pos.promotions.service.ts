import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import type { PosPromo } from "./pos.pricing";

export const posPromotionsService = {
  async listActive(locationId?: string) {
    const now = new Date();
    const rows = await prisma.posPromotion.findMany({
      where: { active: true, startsAt: { lte: now }, endsAt: { gte: now } },
      orderBy: { startsAt: "asc" },
    });
    return rows.filter((p) => {
      const channels = Array.isArray(p.channels) ? (p.channels as string[]) : [];
      if (!channels.includes("pos") && !channels.includes("store")) return false;
      const stores = Array.isArray(p.stores) ? (p.stores as string[]) : [];
      if (stores.length && locationId && !stores.includes(locationId)) return false;
      return true;
    });
  },

  toPromo(row: Awaited<ReturnType<typeof this.listActive>>[number]): PosPromo {
    const scope = (row.scope ?? { type: "all" }) as PosPromo["scope"];
    return {
      id: row.id,
      label: row.label,
      kind: row.kind as PosPromo["kind"],
      buy: row.buy,
      get: row.get,
      value: row.value,
      minSpend: row.minSpend,
      scope: scope?.type ? scope : { type: "all" },
    };
  },

  async create(body: {
    name: string;
    label: string;
    kind: PosPromo["kind"];
    buy?: number;
    get?: number;
    value: number;
    minSpend?: number;
    scope?: PosPromo["scope"];
    channels?: string[];
    stores?: string[];
    startsAt: string;
    endsAt: string;
    active?: boolean;
  }) {
    if (new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Promotion end must be after start.");
    }
    return prisma.posPromotion.create({
      data: {
        name: body.name,
        label: body.label,
        kind: body.kind,
        buy: body.buy,
        get: body.get,
        value: body.value,
        minSpend: body.minSpend,
        scope: (body.scope ?? { type: "all" }) as Prisma.InputJsonValue,
        channels: (body.channels ?? ["pos"]) as Prisma.InputJsonValue,
        stores: (body.stores ?? []) as Prisma.InputJsonValue,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        active: body.active ?? true,
      },
    });
  },
};
