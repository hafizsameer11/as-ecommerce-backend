import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { posGiftCardsService } from "@/modules/pos/pos.giftcards.service";

export type StoreGiftCardBalance = {
  code: string;
  balance: number;
  status: string;
  expiresAt: string;
};

async function assertEnabled() {
  const pos = await settingsService.get("pos");
  if (!pos.giftCardsEnabled) throw ApiError.badRequest("VALIDATION_FAILED", "Gift cards are not available right now.");
}

/** Active card for checkout / balance (no event history). */
export async function activeGiftCard(code: string) {
  await assertEnabled();
  const g = await prisma.giftCard.findUnique({ where: { code: code.toUpperCase() } });
  if (!g || g.status !== "active") throw ApiError.badRequest("VALIDATION_FAILED", "That gift card isn't active.");
  if (g.expiresAt < new Date()) throw ApiError.badRequest("VALIDATION_FAILED", "That gift card has expired.");
  return g;
}

function toBalance(g: { code: string; balance: number; status: string; expiresAt: Date }): StoreGiftCardBalance {
  return { code: g.code, balance: g.balance, status: g.status, expiresAt: g.expiresAt.toISOString() };
}

export const storeGiftCardsService = {
  async balance(code: string) {
    return toBalance(await activeGiftCard(code));
  },

  redeem(code: string, amount: number, ref: string) {
    return posGiftCardsService.redeem(code, amount, ref);
  },
};