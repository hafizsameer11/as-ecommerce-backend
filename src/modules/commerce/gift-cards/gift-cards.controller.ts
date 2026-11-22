import type { Ctx } from "@/core/http/router";
import { storeGiftCardsService } from "./gift-cards.service";

export const storeGiftCardsController = {
  balance: ({ params }: Ctx<unknown, unknown, { code: string }>) => storeGiftCardsService.balance(params.code),
};