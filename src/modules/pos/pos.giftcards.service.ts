import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { randomDigits } from "@/core/auth/tokens";
import type { AdjustGiftCardBody, IssueGiftCardBody } from "./pos.schemas";

function genCode() {
  return `GC-${randomDigits(4)}-${randomDigits(4)}`;
}

export const posGiftCardsService = {
  async list(q: { page: number; pageSize: number; q?: string; status?: string }) {
    const where = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ code: { contains: q.q } }, { customerId: q.q }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.giftCard.findMany({ where, include: { events: { orderBy: { at: "desc" }, take: 5 } }, orderBy: { issuedAt: "desc" }, ...paging(q) }),
      prisma.giftCard.count({ where }),
    ]);
    return withMeta(rows, pageMeta(q, total));
  },

  async get(code: string) {
    const g = await prisma.giftCard.findUnique({ where: { code: code.toUpperCase() }, include: { events: { orderBy: { at: "desc" } } } });
    if (!g) throw ApiError.notFound("Gift card");
    return g;
  },

  async issue(body: IssueGiftCardBody, staffId: string) {
    const pos = await settingsService.get("pos");
    if (!pos.giftCardsEnabled) throw ApiError.badRequest("VALIDATION_FAILED", "Gift cards are turned off.");
    const months = body.expiryMonths ?? 12;
    const code = (body.code ?? genCode()).toUpperCase();
    if (await prisma.giftCard.findUnique({ where: { code } })) throw ApiError.conflict("INVALID_STATE", "That gift card code already exists.");
    const expiresAt = new Date(Date.now() + months * 30.4 * 86_400_000);
    return prisma.giftCard.create({
      data: {
        code,
        initial: body.amount,
        balance: body.amount,
        expiresAt,
        locationId: body.locationId,
        customerId: body.customerId,
        orderId: body.orderId,
        events: { create: { kind: "issued", amount: body.amount, ref: body.orderId, staffId } },
      },
      include: { events: true },
    });
  },

  async redeem(code: string, amount: number, ref: string, staffId?: string) {
    const g = await prisma.giftCard.findUnique({ where: { code: code.toUpperCase() } });
    if (!g || g.status !== "active") throw ApiError.badRequest("VALIDATION_FAILED", "That gift card isn't active.");
    if (g.expiresAt < new Date()) throw ApiError.badRequest("VALIDATION_FAILED", "That gift card has expired.");
    if (amount > g.balance) throw ApiError.badRequest("VALIDATION_FAILED", `Gift card balance is ₦${Math.round(g.balance / 100).toLocaleString("en-NG")}.`);
    const balance = g.balance - amount;
    return prisma.giftCard.update({
      where: { id: g.id },
      data: {
        balance,
        status: balance <= 0 ? "used" : "active",
        events: { create: { kind: "redeemed", amount: -amount, ref, staffId } },
      },
    });
  },

  async adjust(code: string, body: AdjustGiftCardBody, staffId: string) {
    const g = await this.get(code);
    if (g.status === "cancelled") throw ApiError.conflict("INVALID_STATE", "Card is cancelled.");
    const balance = Math.max(0, g.balance + body.amount);
    return prisma.giftCard.update({
      where: { id: g.id },
      data: {
        balance,
        status: body.cancel ? "cancelled" : balance <= 0 ? "used" : "active",
        events: {
          create: {
            kind: body.cancel ? "cancelled" : "adjusted",
            amount: body.amount,
            ref: body.note,
            staffId,
          },
        },
      },
      include: { events: { orderBy: { at: "desc" }, take: 10 } },
    });
  },
};
