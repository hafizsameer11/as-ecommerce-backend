import { withMeta, type Ctx } from "@/core/http/router";
import { inventoryService as svc, warehousesService } from "./inventory.service";
import type { AdjustBody, MovementsQuery, ReorderPointBody, StockListQuery, TransferBody, WarehouseBody, WarehousePatch } from "./inventory.schemas";

type Id = { id: string };

export const inventoryController = {
  list: async ({ query }: Ctx<unknown, StockListQuery>) => {
    const r = await svc.list(query);
    return withMeta(r.items, r.meta);
  },
  adjust: ({ body, admin, res }: Ctx<AdjustBody>) => {
    res.locals.audit = { entityId: body.sku, summary: `${body.delta > 0 ? "+" : ""}${body.delta} ${body.sku} @ ${body.warehouseId}: ${body.note}` };
    return svc.adjust(body, admin.name);
  },
  transfer: ({ body, admin }: Ctx<TransferBody>) => svc.transfer(body, admin.name),
  setReorderPoint: ({ body }: Ctx<ReorderPointBody>) => svc.setReorderPoint(body.sku, body.warehouseId, body.reorderPoint),
  movements: async ({ query }: Ctx<unknown, MovementsQuery>) => {
    const r = await svc.movements(query);
    return withMeta(r.items, r.meta);
  },
};

export const warehousesController = {
  list: () => warehousesService.list(),
  create: ({ body }: Ctx<WarehouseBody>) => warehousesService.create(body),
  update: ({ params, body }: Ctx<WarehousePatch, unknown, Id>) => warehousesService.update(params.id, body),
};
