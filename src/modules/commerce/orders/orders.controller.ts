import { z } from "zod";
import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import { ordersService as svc } from "./orders.service";
import type { adminCancelBody, AdminOrderQuery, bulkBody, cancelBody, lookupBody, markPaidBody, myOrdersQuery, payAgainBody, RefundBody, statusBody } from "./orders.schemas";

type Id = { id: string };
type B<T extends z.ZodType> = z.infer<T>;

export const ordersController = {
  // customer
  myOrders: ({ customerId, query }: Ctx<unknown, B<typeof myOrdersQuery>>) => svc.myOrders(customerId, query),
  myOrder: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.myOrder(customerId, params.id),
  cancel: ({ customerId, params, body }: Ctx<B<typeof cancelBody>, unknown, Id>) => svc.cancelByCustomer(customerId, params.id, body.reason),
  pay: ({ customerId, params, body }: Ctx<B<typeof payAgainBody>, unknown, Id>) =>
    svc.payAgain({ customerId, OR: [{ id: params.id }, { number: params.id }] }, body),
  reorder: ({ customerId, params }: Ctx<unknown, unknown, Id>) => svc.reorder(customerId, params.id),
  // guest (order access token from place-order)
  byToken: ({ params }: Ctx<unknown, unknown, { token: string }>) => svc.byAccessToken(params.token),
  payByToken: ({ params, body }: Ctx<B<typeof payAgainBody>, unknown, { token: string }>) => svc.payAgain({ accessToken: params.token }, body),
  lookup: ({ body }: Ctx<B<typeof lookupBody>>) => svc.lookup(body.orderNumber, body.email),

  // admin
  list: ({ query }: Ctx<unknown, AdminOrderQuery>) => svc.adminList(query),
  get: ({ params }: Ctx<unknown, unknown, Id>) => svc.adminGet(params.id),
  setStatus: ({ params, body, admin }: Ctx<B<typeof statusBody>, unknown, Id>) => svc.setStatus(params.id, body.status, admin.name, body.note),
  bulk: ({ body, admin }: Ctx<B<typeof bulkBody>>) => svc.bulkStatus(body.ids, body.status, admin.name),
  adminCancel: ({ params, body, admin }: Ctx<B<typeof adminCancelBody>, unknown, Id>) => svc.adminCancel(params.id, body, admin.name),
  markPaid: ({ params, body, admin }: Ctx<B<typeof markPaidBody>, unknown, Id>) => svc.markPaid(params.id, body, admin.name),
  addNote: ({ params, body, admin }: Ctx<{ body: string }, unknown, Id>) => svc.addNote(params.id, body.body, admin.name),
  removeNote: ({ params }: Ctx<unknown, unknown, Id & { noteId: string }>) => svc.removeNote(params.id, params.noteId),
  refund: ({ params, body, admin }: Ctx<RefundBody, unknown, Id>) => svc.refund(params.id, body, admin.name),
  exportCsv: async ({ query, res }: Ctx<unknown, AdminOrderQuery>) => sendCsv(res, "orders", await svc.exportCsv(query)),
};
