import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { events } from "@/core/events/bus";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { slaDue } from "@/modules/concierge/concierge.common";
import type { CreateConciergeBody } from "./pos.schemas";
import type { ConciergePriority } from "@/generated/prisma/client";

type Staff = { id: string; name: string };

const TIER_PRIORITY: Record<string, ConciergePriority> = {
  Standard: "standard",
  Silver: "standard",
  Gold: "priority",
  Signature: "vip",
};

export const posConciergeService = {
  async create(body: CreateConciergeBody, staff: Staff) {
    const cfg = await settingsService.get("concierge");
    const customer = body.customerId ? await prisma.customer.findUnique({ where: { id: body.customerId } }) : null;
    if (body.customerId && !customer) throw ApiError.notFound("Customer");
    if (!customer && (!body.contactName || !body.contactEmail)) {
      throw ApiError.badRequest("VALIDATION_FAILED", "Link a customer or provide name and e-mail.");
    }

    const priority: ConciergePriority = customer ? TIER_PRIORITY[customer.tier] ?? "standard" : "standard";
    const now = new Date();
    const contactName = customer ? fullName(customer) : body.contactName!;
    const contactEmail = customer?.email ?? body.contactEmail!;
    const contactPhone = body.contactPhone ?? customer?.phone ?? null;

    const r = await prisma.$transaction(async (tx) => {
      const number = formatters.concierge(await nextSequence(tx, "concierge", 123457));
      const created = await tx.conciergeRequest.create({
        data: {
          number,
          customerId: customer?.id ?? null,
          contactName,
          contactEmail,
          contactPhone,
          source: "store",
          originLocationId: body.locationId,
          createdByStaffId: staff.id,
          category: body.category,
          brand: body.brand ?? null,
          itemName: body.itemName,
          description: body.description ?? null,
          size: body.size ?? null,
          color: body.color ?? null,
          budget: body.budget ?? null,
          notes: body.notes ?? `Logged at till by ${staff.name}`,
          qty: body.qty,
          priority,
          createdAt: now,
          slaDueAt: slaDue(now, priority, cfg),
          timeline: {
            create: [{ kind: "status", text: `Request logged from boutique till by ${staff.name}.`, by: "System" }],
          },
          thread: { create: {} },
        },
      });
      if (customer) {
        await tx.customerStats.upsert({
          where: { customerId: customer.id },
          create: { customerId: customer.id, conciergeCount: 1 },
          update: { conciergeCount: { increment: 1 } },
        });
      }
      await tx.posAuditEvent.create({
        data: {
          locationId: body.locationId,
          staffId: staff.id,
          action: "concierge",
          text: `${staff.name} logged concierge ${number}`,
          ref: number,
        },
      });
      return created;
    });

    events.emit("concierge.requested", { requestId: r.id });
    return prisma.conciergeRequest.findUniqueOrThrow({
      where: { id: r.id },
      include: { timeline: true },
    });
  },
};
