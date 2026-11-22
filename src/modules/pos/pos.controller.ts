import type { Ctx } from "@/core/http/router";
import { prisma } from "@/core/db/prisma";
import { POS_DISCOUNT_LIMITS } from "@/core/auth/permissions";
import { setAdminCookies } from "@/modules/identity/admin-auth/admin-auth.service";
import { settingsService } from "@/modules/platform/settings/settings.service";
import type { SessionMeta } from "@/modules/identity/auth/session.service";
import { posAuthService } from "./pos.auth.service";
import { posCatalogService } from "./pos.catalog.service";
import { posSalesService } from "./pos.sales.service";
import { posSessionService } from "./pos.session.service";
import type {
  CashMoveBody,
  CatalogQuery,
  CloseSessionBody,
  CompleteSaleBody,
  CreateCustomerBody,
  CustomersQuery,
  OpenSessionBody,
  PinLoginBody,
  QuoteBody,
  SyncSalesBody,
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

  quote: ({ body }: Ctx<QuoteBody>) => posSalesService.quote(body),

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
};
