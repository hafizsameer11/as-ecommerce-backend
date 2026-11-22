import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { nextSequence } from "@/core/utils/sequence";
import type { AlterationStatusBody, CreateAlterationBody } from "./pos.schemas";

type Staff = { id: string; name: string };

export const posAlterationsService = {
  async list(q: { page: number; pageSize: number; locationId?: string; status?: string }) {
    const where = {
      ...(q.locationId ? { locationId: q.locationId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.posAlteration.findMany({ where, orderBy: { createdAt: "desc" }, ...paging(q) }),
      prisma.posAlteration.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async create(body: CreateAlterationBody, staff: Staff) {
    const number = await prisma.$transaction(async (tx) => {
      const n = await nextSequence(tx, "pos_alteration", 2040);
      return `ALT-${n}`;
    });
    return prisma.posAlteration.create({
      data: {
        number,
        customerId: body.customerId,
        customerName: body.customerName,
        phone: body.phone,
        orderNumber: body.orderNumber,
        item: body.item,
        work: body.work as Prisma.InputJsonValue,
        notes: body.notes,
        fee: body.fee,
        locationId: body.locationId,
        staffId: staff.id,
        tailor: body.tailor,
        readyBy: new Date(body.readyBy),
      },
    });
  },

  async setStatus(id: string, body: AlterationStatusBody, staff: Staff) {
    const a = await prisma.posAlteration.findUnique({ where: { id } });
    if (!a) throw ApiError.notFound("Alteration");
    const collectedAt = body.status === "collected" ? new Date() : a.collectedAt;
    const updated = await prisma.posAlteration.update({
      where: { id },
      data: { status: body.status, collectedAt },
    });
    await prisma.posAuditEvent.create({
      data: {
        locationId: a.locationId,
        staffId: staff.id,
        action: "alteration",
        text: `${staff.name} marked ${a.number} ${body.status}`,
        ref: a.number,
      },
    });
    return updated;
  },
};
