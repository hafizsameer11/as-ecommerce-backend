/**
 * Domain events → socket events that no single service emits directly (see realtime.ts for the catalogue):
 * order status for the owning customer, concierge request updates, and reconnecting staff sockets whose access changed.
 * Inbox rows, bell rows, chat / ticket messages and activity rows are emitted where they are written.
 */
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { realtime } from "./realtime";

let registered = false;

async function orderUpdated(orderId: string, event: string) {
  if (!realtime.attached) return;
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, number: true, customerId: true, status: true, paymentStatus: true } });
  if (!o?.customerId) return;
  realtime.emit(`customer:${o.customerId}`, "order.updated", {
    orderId: o.id, number: o.number, status: o.status, statusLabel: (STATUS_LABELS.order.customer as Record<string, string>)[o.status] ?? o.status,
    paymentStatus: o.paymentStatus, event,
  });
}

async function conciergeUpdated(requestId: string, event: "status" | "quoted") {
  if (!realtime.attached) return;
  const r = await prisma.conciergeRequest.findUnique({ where: { id: requestId }, select: { id: true, number: true, status: true, customerId: true } });
  if (!r) return;
  const rooms = [`concierge:request:${r.id}`, "admin:perm:concierge.view", ...(r.customerId ? [`customer:${r.customerId}`] : [])];
  realtime.emit(rooms, "concierge.updated", {
    requestId: r.id, number: r.number, status: r.status, statusLabel: STATUS_LABELS.concierge.customer[r.status], event,
  });
}

export function registerRealtimeListeners() {
  if (registered) return;
  registered = true;

  events.on("order.status_changed", ({ orderId }) => orderUpdated(orderId, "status_changed"));
  events.on("order.paid", ({ orderId }) => orderUpdated(orderId, "paid"));
  events.on("order.cancelled", ({ orderId }) => orderUpdated(orderId, "cancelled"));
  events.on("order.shipped", ({ orderId }) => orderUpdated(orderId, "shipped"));
  events.on("order.delivered", ({ orderId }) => orderUpdated(orderId, "delivered"));
  events.on("order.refunded", ({ orderId }) => orderUpdated(orderId, "refunded"));

  events.on("concierge.status_changed", ({ requestId }) => conciergeUpdated(requestId, "status"));
  events.on("concierge.quoted", async ({ quoteId }) => {
    const q = await prisma.conciergeQuote.findUnique({ where: { id: quoteId }, select: { requestId: true } });
    if (q) await conciergeUpdated(q.requestId, "quoted");
  });

  // rooms are computed at connect time → make affected staff sockets reconnect with their new role / permissions
  events.on("team.access_changed", ({ kind, adminId, role }) => {
    realtime.disconnect(kind === "permissions" ? `admin:role:${role}` : adminId ? `admin:${adminId}` : `admin:role:${role}`);
  });
  // a blocked customer's sockets go too (their sessions were revoked)
  events.on("customer.status_changed", ({ customerId, to }) => {
    if (to === "blocked") realtime.disconnect(`customer:${customerId}`);
  });
}
