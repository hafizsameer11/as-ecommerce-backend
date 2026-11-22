import type { Ctx } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { POS_DISCOUNT_LIMITS } from "@/core/auth/permissions";
import { setAdminCookies } from "@/modules/identity/admin-auth/admin-auth.service";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SessionMeta } from "@/modules/identity/auth/session.service";
import { posAuthService } from "./pos.auth.service";
import { posAlterationsService } from "./pos.alterations.service";
import { posCatalogService } from "./pos.catalog.service";
import { posConciergeService } from "./pos.concierge.service";
import { posGiftCardsService } from "./pos.giftcards.service";
import { posLayawayService } from "./pos.layaway.service";
import { posOutboundService } from "./pos.outbound.service";
import { posPickupsService } from "./pos.pickups.service";
import { posPromotionsService } from "./pos.promotions.service";
import { posReturnsService } from "./pos.returns.service";
import { posSalesService } from "./pos.sales.service";
import { posSessionService } from "./pos.session.service";
import { posStockService } from "./pos.stock.service";
import type {
  AdjustGiftCardBody,
  AlterationStatusBody,
  CashMoveBody,
  CatalogQuery,
  CloseSessionBody,
  CollectPickupBody,
  CompleteSaleBody,
  CreateAlterationBody,
  CreateConciergeBody,
  CreateCustomerBody,
  AdjustStockBody,
  CreateGrnBody,
  CreateStockCountBody,
  CreateTransferBody,
  CustomersQuery,
  GiftCardsQuery,
  IssueGiftCardBody,
  OpenSessionBody,
  PickupsQuery,
  PinLoginBody,
  PosReturnBody,
  QuoteBody,
  ReceiveGrnBody,
  SalesListQuery,
  AdvanceShipBody,
  SendReceiptBody,
  SettleLayawayBody,
  CancelLayawayBody,
  ShippingQuoteBody,
  SyncSalesBody,
  TransferStepBody,
} from "./pos.schemas";

function metaFrom(req: Ctx["req"]): SessionMeta {
  return { ip: req.ip, userAgent: req.get("user-agent") ?? undefined };
}

function staff(admin: Ctx["admin"]) {
  return { id: admin.id, name: admin.name, role: String(admin.role) };
}

async function warehouseFor(registerId: string | undefined) {
  if (!registerId) return undefined;
  const r = await prisma.posRegister.findUnique({ where: { id: registerId }, select: { warehouseId: true } });
  return r?.warehouseId;
}

async function locationIdsFor(adminId: string) {
  const a = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { locationIds: true } });
  return Array.isArray(a?.locationIds) ? (a!.locationIds as string[]) : [];
}

export const posController = {
  pinLogin: async ({ body, req, res }: Ctx<PinLoginBody>) => {
    const out = await posAuthService.pinLogin(body, metaFrom(req));
    setAdminCookies(res, out);
    return out;
  },

  me: async ({ admin }: Ctx) => {
    const a = await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
    const locationIds = Array.isArray(a.locationIds) ? (a.locationIds as string[]) : [];
    const discountLimitPct =
      a.role === "store_cashier" || a.role === "store_supervisor" || a.role === "store_manager"
        ? POS_DISCOUNT_LIMITS[a.role]
        : a.role === "super_admin" || a.role === "ops_manager"
          ? 100
          : 0;
    return {
      id: a.id,
      name: a.name,
      email: a.email,
      role: a.role,
      permissions: [...admin.permissions],
      locationIds,
      discountLimitPct,
    };
  },

  settings: () => settingsService.get("pos"),

  listRegisters: async ({ admin }: Ctx) => posSessionService.listRegisters(await locationIdsFor(admin.id)),

  openSession: ({ params, body, admin }: Ctx<OpenSessionBody, unknown, { id: string }>) =>
    posSessionService.open(params.id, body, staff(admin)),

  cashMove: ({ params, body, admin }: Ctx<CashMoveBody, unknown, { id: string }>) =>
    posSessionService.cashMove(params.id, body, staff(admin)),

  closeSession: ({ params, body, admin }: Ctx<CloseSessionBody, unknown, { id: string }>) =>
    posSessionService.close(params.id, body, staff(admin)),

  zReport: ({ params }: Ctx<unknown, unknown, { id: string }>) => posSessionService.zReport(params.id),

  catalog: async ({ query, req }: Ctx<unknown, CatalogQuery>) => {
    const registerId = typeof req.headers["x-pos-register"] === "string" ? req.headers["x-pos-register"] : undefined;
    return posCatalogService.catalog(query, await warehouseFor(registerId));
  },

  product: async ({ params, req }: Ctx<unknown, unknown, { id: string }>) => {
    const registerId = typeof req.headers["x-pos-register"] === "string" ? req.headers["x-pos-register"] : undefined;
    return posCatalogService.product(params.id, await warehouseFor(registerId));
  },

  customers: ({ query }: Ctx<unknown, CustomersQuery>) => posCatalogService.searchCustomers(query),
  createCustomer: ({ body }: Ctx<CreateCustomerBody>) => posCatalogService.createCustomer(body),

  quote: ({ body }: Ctx<QuoteBody>) => posSalesService.quote(body, body.locationId),
  shippingQuote: ({ body }: Ctx<ShippingQuoteBody>) => posSalesService.shippingOptions(body),

  completeSale: async ({ body, admin, res }: Ctx<CompleteSaleBody>) => {
    const sale = await posSalesService.complete(body, staff(admin));
    res.locals.audit = { entityId: sale.id, summary: `POS sale ${sale.number}`, after: { total: sale.total } };
    return sale;
  },

  syncSales: async ({ body, admin, res }: Ctx<SyncSalesBody>) => {
    const out = await posSalesService.sync(body, staff(admin));
    res.locals.audit = { entityId: admin.id, summary: `POS synced ${out.synced} offline sales` };
    return out;
  },

  getSale: ({ params }: Ctx<unknown, unknown, { id: string }>) => posSalesService.getSale(params.id),
  listSales: ({ query }: Ctx<unknown, SalesListQuery>) => posSalesService.listSales(query),
  advanceShip: async ({ params, body, admin, res }: Ctx<AdvanceShipBody, unknown, { id: string }>) => {
    const sale = await posSalesService.advanceShip(params.id, body, staff(admin));
    res.locals.audit = { entityId: sale.id, summary: `POS ship ${body.status} ${sale.number}` };
    return sale;
  },

  returnable: ({ params }: Ctx<unknown, unknown, { id: string }>) => posReturnsService.returnable(params.id),
  processReturn: async ({ params, body, admin, res }: Ctx<PosReturnBody, unknown, { id: string }>) => {
    const r = await posReturnsService.process(params.id, body, staff(admin));
    res.locals.audit = { entityId: r.id, summary: `POS return ${r.number}`, after: { amount: r.amount } };
    return r;
  },

  settleLayaway: async ({ params, body, admin, res }: Ctx<SettleLayawayBody, unknown, { id: string }>) => {
    const out = await posLayawayService.settle(params.id, body, staff(admin));
    res.locals.audit = { entityId: out.order.id, summary: `Layaway settled ${out.order.number}` };
    return out;
  },
  cancelLayaway: async ({ params, body, admin, res }: Ctx<CancelLayawayBody, unknown, { id: string }>) => {
    const out = await posLayawayService.cancel(params.id, staff(admin), body);
    res.locals.audit = { entityId: out.order.id, summary: `Layaway cancelled ${out.order.number}` };
    return out;
  },

  pickups: async ({ query, admin }: Ctx<unknown, PickupsQuery>) =>
    posPickupsService.list(query, await locationIdsFor(admin.id)),
  pickupReady: async ({ params, admin, res }: Ctx<unknown, unknown, { id: string }>) => {
    const b = await posPickupsService.markReady(params.id, staff(admin));
    res.locals.audit = { entityId: b.id, summary: `Pickup ${b.number} ready` };
    return b;
  },
  pickupCollect: async ({ params, body, admin, res }: Ctx<CollectPickupBody, unknown, { id: string }>) => {
    const b = await posPickupsService.collect(params.id, body, staff(admin));
    res.locals.audit = { entityId: b.id, summary: `Pickup ${b.number} collected` };
    return b;
  },

  sendReceipt: ({ params, body, admin }: Ctx<SendReceiptBody, unknown, { id: string }>) =>
    posOutboundService.sendReceipt(params.id, body, admin.id),

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

  listPromotions: async ({ req }: Ctx) => {
    const registerId = typeof req.headers["x-pos-register"] === "string" ? req.headers["x-pos-register"] : undefined;
    const loc = registerId
      ? (await prisma.posRegister.findUnique({ where: { id: registerId }, select: { locationId: true } }))?.locationId
      : undefined;
    return posPromotionsService.listActive(loc);
  },

  listAlterations: ({ query }: Ctx<unknown, { page: number; pageSize: number; locationId?: string; status?: string }>) =>
    posAlterationsService.list(query),
  createAlteration: ({ body, admin }: Ctx<CreateAlterationBody>) => posAlterationsService.create(body, staff(admin)),
  alterationStatus: ({ params, body, admin }: Ctx<AlterationStatusBody, unknown, { id: string }>) =>
    posAlterationsService.setStatus(params.id, body, staff(admin)),

  adjustStock: ({ body, admin }: Ctx<AdjustStockBody>) => posStockService.adjust(body, staff(admin)),
  listTransfers: ({ query }: Ctx<unknown, { page: number; pageSize: number; warehouseId?: string; status?: string }>) =>
    posStockService.listTransfers(query),
  createTransfer: ({ body, admin }: Ctx<CreateTransferBody>) => posStockService.requestTransfer(body, staff(admin)),
  stepTransfer: ({ params, body, admin }: Ctx<TransferStepBody, unknown, { id: string }>) =>
    posStockService.stepTransfer(params.id, body, staff(admin)),

  listCounts: ({ query }: Ctx<unknown, { page: number; pageSize: number; warehouseId?: string }>) =>
    posStockService.listCounts(query),
  createCount: ({ body, admin }: Ctx<CreateStockCountBody>) => posStockService.createCount(body, staff(admin)),
  postCount: ({ params, admin }: Ctx<unknown, unknown, { id: string }>) => posStockService.postCount(params.id, staff(admin)),

  listGrn: ({ query }: Ctx<unknown, { page: number; pageSize: number; warehouseId?: string; status?: string }>) =>
    posStockService.listGrn(query),
  createGrn: ({ body }: Ctx<CreateGrnBody>) => posStockService.createGrn(body),
  receiveGrn: ({ params, body, admin }: Ctx<ReceiveGrnBody, unknown, { id: string }>) =>
    posStockService.receiveGrn(params.id, body, staff(admin)),

  createConcierge: async ({ body, admin, res }: Ctx<CreateConciergeBody>) => {
    const r = await posConciergeService.create(body, staff(admin));
    res.locals.audit = { entityId: r.id, summary: `Concierge ${r.number} from till` };
    return r;
  },
};
