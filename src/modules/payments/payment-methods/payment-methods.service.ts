/**
 * Saved cards. Card numbers never reach this server: a card is saved from the gateway's
 * authorization after a successful payment (`saveCard: true`), or with a small
 * verification charge that is refunded straight away.
 */
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { paymentsService } from "@/modules/payments/payments/payments.service";

export const VERIFY_CHARGE = 5_000; // ₦50

const toDto = (m: Awaited<ReturnType<typeof prisma.savedPaymentMethod.findFirstOrThrow>>) => ({
  id: m.id, type: m.type, brand: m.brand, last4: m.last4, expMonth: m.expMonth, expYear: m.expYear, holderName: m.holderName,
  bankName: m.bankName, nickname: m.nickname, isDefault: m.isDefault, createdAt: m.createdAt,
  expired: !!m.expYear && !!m.expMonth && new Date(m.expYear, m.expMonth) < new Date(),
});

export const paymentMethodsService = {
  async list(customerId: string) {
    const rows = await prisma.savedPaymentMethod.findMany({ where: { customerId }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
    return rows.map(toDto);
  },

  /** "Add card" → open the returned `authorizationUrl`; the ₦50 check is refunded automatically */
  async startAdd(customerId: string, returnUrl?: string | null) {
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { email: true } });
    return paymentsService.start({ purpose: "card_authorization", amount: VERIFY_CHARGE, email: c.email, customerId, method: "card", saveCard: true, returnUrl });
  },

  async update(customerId: string, id: string, b: { nickname?: string | null; isDefault?: boolean }) {
    const m = await prisma.savedPaymentMethod.findFirst({ where: { id, customerId } });
    if (!m) throw ApiError.notFound("Payment method");
    await prisma.$transaction(async (tx) => {
      if (b.isDefault) await tx.savedPaymentMethod.updateMany({ where: { customerId }, data: { isDefault: false } });
      await tx.savedPaymentMethod.update({ where: { id }, data: b });
    });
    return this.list(customerId);
  },

  async remove(customerId: string, id: string) {
    const m = await prisma.savedPaymentMethod.findFirst({ where: { id, customerId } });
    if (!m) throw ApiError.notFound("Payment method");
    await prisma.savedPaymentMethod.delete({ where: { id } });
    if (m.isDefault) {
      const next = await prisma.savedPaymentMethod.findFirst({ where: { customerId }, orderBy: { createdAt: "desc" } });
      if (next) await prisma.savedPaymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return { deleted: true };
  },
};

// the verification charge is given straight back
paymentsService.register("card_authorization", {
  async succeeded(tx, p) {
    await paymentsService.refund(tx, p.id, p.amount, "Card verification", "system");
  },
});
