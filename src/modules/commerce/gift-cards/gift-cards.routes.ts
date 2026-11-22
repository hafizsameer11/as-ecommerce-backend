import { z } from "zod";
import { ModuleRouter } from "@/core/http/router";
import { lookupLimiter } from "@/core/middleware/rate-limit";
import { storeGiftCardsController as c } from "./gift-cards.controller";

const codeParam = z.object({ code: z.string().trim().min(4).max(32) });

/** Public balance check (same cards as POS / till). */
export const giftCardsStoreRoutes = new ModuleRouter({ surface: "store", prefix: "/gift-cards", tag: "Gift cards" })
  .get("/:code/balance", {
    summary: "Gift card balance by code",
    params: codeParam,
    auth: "public",
    middleware: [lookupLimiter],
  }, c.balance);