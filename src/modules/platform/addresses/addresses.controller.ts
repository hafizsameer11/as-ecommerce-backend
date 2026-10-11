import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { addressesService as svc } from "./addresses.service";
import type { AddressBody, AddressPatch, AdminAddressQuery } from "./addresses.schemas";

type Id = { id: string };

export const addressesController = {
  // customer /account/addresses
  list: ({ customerId }: Ctx) => svc.list(customerId),
  get: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.get(customerId, params.id),
  create: ({ customerId, body }: Ctx<AddressBody>) => svc.create(customerId, body),
  update: ({ customerId, params, body }: Ctx<AddressPatch, unknown, Id>) => svc.update(customerId, params.id, body),
  setDefault: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.setDefault(customerId, params.id),
  remove: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.remove(customerId, params.id),

  // admin /addresses
  adminList: ({ query }: Ctx<unknown, AdminAddressQuery>) => svc.adminList(query),
  adminUpdate: async ({ params, body, res }: Ctx<AddressPatch & { notes?: string | null }, unknown, Id>) => {
    const r = await svc.adminUpdate(params.id, body);
    res.locals.audit = { entityId: params.id, before: r.before, after: r.after, summary: `Edited address of ${r.after.customerName}` };
    return r.after;
  },
  verify: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminFlag(params.id, { verified: true }),
  flag: ({ params, body }: Ctx<{ flagged: boolean }, unknown, Id>) => svc.adminFlag(params.id, { flagged: body.flagged }),
  adminDefault: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminDefault(params.id),
  adminRemove: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminRemove(params.id),
  exportCsv: async ({ query, res }: Ctx<unknown, AdminAddressQuery>) => sendCsv(res, "addresses", await svc.exportCsv(query)),
};
