/**
 * Customer notifications for order lifecycle events (email to the order's contact address —
 * guests included — plus push for signed-in customers).
 *
 * Transactional e-mails (confirmed, shipped, cancelled, pick-up ready) always go out. Push and SMS follow the
 * customer's notification preferences (`preferred.*`): confirmed / cancelled / pick-up → topic `orders`,
 * shipped / delivered → topic `shipping`.
 */
import { env } from "@/config/env";
import { prisma } from "@/core/db/prisma";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { CARRIER_LABEL } from "@/modules/fulfilment/shipments/shipments.mapper";
import { pickupsService } from "@/modules/fulfilment/pickups/pickups.service";
import { preferred } from "@/modules/support/notifications/notifications.service";

type Contact = { email?: string; phone?: string };

async function context(orderId: string) {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: { select: { id: true, firstName: true, email: true, phone: true } }, pickupLocation: { select: { name: true } } },
  });
  if (!o) return null;
  const contact = (o.contact ?? {}) as Contact;
  const addressName = ((o.shippingAddress ?? {}) as { fullName?: string }).fullName?.split(" ")[0];
  const vars = {
    firstName: o.customer?.firstName || addressName || "there",
    orderNumber: o.number,
    // seeded templates link to /account/orders/{{orderId}}; the apps accept the number there
    orderId: o.number,
    orderUrl: o.customerId ? `${env.WEB_URL}/account/orders/${o.number}` : `${env.WEB_URL}/order/${o.accessToken}`,
    total: formatNaira(o.total),
    location: o.pickupLocation?.name ?? "",
    reason: o.cancelReason ?? "",
  };
  return {
    order: o,
    email: contact.email || o.customer?.email || o.guestEmail || null,
    phone: contact.phone || o.customer?.phone || null,
    customerId: o.customerId,
    vars,
  };
}

const pushData = (orderId: string, number: string) => ({ type: "order", orderId, orderNumber: number });

let registered = false;

export function registerOrderListeners() {
  if (registered) return;
  registered = true;

  events.on("order.paid", async ({ orderId }) => {
    const c = await context(orderId);
    if (!c) return;
    if (c.email) await messaging.email(c.email, "order.confirmed", c.vars);
    await preferred.push(c.customerId, "orders", "order.confirmed", c.vars, pushData(orderId, c.order.number));
  });

  events.on("order.shipped", async ({ orderId, shipmentId }) => {
    const c = await context(orderId);
    if (!c) return;
    const s = await prisma.shipment.findUnique({ where: { id: shipmentId }, select: { carrier: true, trackingNumber: true, service: true } });
    const vars = {
      ...c.vars,
      carrier: s ? CARRIER_LABEL[s.carrier] : "our courier",
      tracking: s?.trackingNumber || "we'll share it as soon as the courier scans your parcel",
      service: s?.service ?? "",
    };
    if (c.email) await messaging.email(c.email, "order.shipped", vars);
    await preferred.push(c.customerId, "shipping", "order.shipped", vars, pushData(orderId, c.order.number));
  });

  events.on("order.delivered", async ({ orderId }) => {
    const c = await context(orderId);
    if (c) await preferred.push(c.customerId, "shipping", "order.delivered", c.vars, pushData(orderId, c.order.number));
  });

  events.on("order.cancelled", async ({ orderId }) => {
    const c = await context(orderId);
    if (c?.email) await messaging.email(c.email, "order.cancelled", c.vars);
  });

  events.on("pickup.ready", async ({ bookingId }) => {
    const b = await pickupsService.readyContext(bookingId);
    if (!b) return;
    const c = await context(b.orderId);
    if (!c) return;
    const vars = { ...c.vars, location: b.location.name, address: b.location.address, hours: b.location.hours, bookingNumber: b.number };
    await preferred.sms(c.customerId, c.phone, "orders", "pickup.ready", vars);
    await preferred.push(c.customerId, "orders", "pickup.ready", vars, pushData(c.order.id, c.order.number));
    if (c.email) await messaging.email(c.email, "pickup.ready", vars);
  });
}
