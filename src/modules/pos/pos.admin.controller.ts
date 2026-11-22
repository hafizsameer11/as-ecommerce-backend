import type { Ctx } from "@/core/http/router";
import { settingsSchemas } from "@/modules/platform/settings/settings.defaults";
import { posAdminService as svc } from "./pos.admin.service";
import { posGiftCardsService } from "./pos.giftcards.service";
import type {
  AdminAuditQuery,
  AdminPromoBody,
  AdminPromoPatch,
  AdminRegisterBody,
  AdminReportsQuery,
  AdminSessionsQuery,
  AdminStockMovesQuery,
  AdminTxQuery,
} from "./pos.admin.schemas";
import type { AdjustGiftCardBody, GiftCardsQuery, IssueGiftCardBody } from "./pos.schemas";

export const posAdminController = {
  overview: () => svc.overview(),
  transactions: ({ query }: Ctx<unknown, AdminTxQuery>) => svc.transactions(query),
  reports: ({ query }: Ctx<unknown, AdminReportsQuery>) => svc.reports(query),
  listRegisters: () => svc.listRegisters(),
  upsertRegister: async ({ body, res }: Ctx<AdminRegisterBody>) => {
    const r = await svc.upsertRegister(body);
    res.locals.audit = { entityId: r.id, summary: `POS register ${r.name}` };
    return r;
  },
  listSessions: ({ query }: Ctx<unknown, AdminSessionsQuery>) => svc.listSessions(query),
  audit: ({ query }: Ctx<unknown, AdminAuditQuery>) => svc.audit(query),
  stockMoves: ({ query }: Ctx<unknown, AdminStockMovesQuery>) => svc.stockMoves(query),
  listPromotions: () => svc.listPromotions(),
  createPromotion: async ({ body, res }: Ctx<AdminPromoBody>) => {
    const p = await svc.createPromotion(body);
    res.locals.audit = { entityId: p.id, summary: `POS promo ${p.name}` };
    return p;
  },
  updatePromotion: async ({ params, body, res }: Ctx<AdminPromoPatch, unknown, { id: string }>) => {
    const p = await svc.updatePromotion(params.id, body);
    res.locals.audit = { entityId: p.id, summary: `Updated POS promo ${p.name}` };
    return p;
  },
  listGiftCards: ({ query }: Ctx<unknown, GiftCardsQuery>) => posGiftCardsService.list(query),
  getGiftCard: ({ params }: Ctx<unknown, unknown, { code: string }>) => posGiftCardsService.get(params.code),
  issueGiftCard: async ({ body, admin, res }: Ctx<IssueGiftCardBody>) => {
    const g = await posGiftCardsService.issue(body, admin.id);
    res.locals.audit = { entityId: g.id, summary: `Issued gift card ${g.code}` };
    return g;
  },
  adjustGiftCard: async ({ params, body, admin, res }: Ctx<AdjustGiftCardBody, unknown, { code: string }>) => {
    const g = await posGiftCardsService.adjust(params.code, body, admin.id);
    res.locals.audit = { entityId: g.id, summary: `Adjusted gift card ${g.code}` };
    return g;
  },
  settings: () => svc.settings(),
  updateSettings: async ({ body, admin, res }: Ctx<Record<string, unknown>>) => {
    const parsed = settingsSchemas.pos.partial().parse(body);
    const out = await svc.updateSettings(parsed, admin.id);
    res.locals.audit = { entityId: "pos", summary: "Updated POS settings" };
    return out;
  },
};
