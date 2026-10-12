import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { suppliersService as svc } from "./suppliers.service";
import type { SupplierBody, SupplierPatch, SuppliersQuery } from "./suppliers.schemas";

type Id = { id: string };

export const suppliersController = {
  list: ({ query }: Ctx<unknown, SuppliersQuery>) => svc.list(query),
  exportCsv: async ({ query, res }: Ctx<unknown, SuppliersQuery>) => sendCsv(res, "suppliers", await svc.exportCsv(query)),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.get(params.id),
  create: async ({ body, res }: Ctx<SupplierBody>) => {
    const s = await svc.create(body);
    res.locals.audit = { entityId: s.id, summary: `Added supplier ${s.name}`, after: { tier: s.tier, status: s.status } };
    return s;
  },
  update: async ({ params, body, res }: Ctx<SupplierPatch, unknown, Id>) => {
    const s = await svc.update(params.id, body);
    res.locals.audit = { entityId: s.id, summary: `Updated supplier ${s.name}`, after: body };
    return s;
  },
  toggleVip: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.toggleVip(params.id);
    res.locals.audit = { entityId: s.id, summary: `${s.vip ? "Marked" : "Unmarked"} ${s.name} as VIP` };
    return s;
  },
  remove: async ({ params, res }: Ctx<unknown, unknown, Id>) => {
    const s = await svc.remove(params.id);
    res.locals.audit = { entityId: s.id, summary: `Deleted supplier ${s.name}` };
    return s;
  },
};
