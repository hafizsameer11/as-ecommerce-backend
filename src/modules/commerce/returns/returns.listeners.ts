import { events } from "@/core/events/bus";
import { prisma } from "@/core/db/prisma";
import { STATUS_LABELS } from "@/modules/platform/settings/status-labels";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { customerStatusNote } from "./returns.mapper";

let registered = false;

/** every return status change → email the customer (`return.updated` template) */
export function registerReturnListeners() {
  if (registered) return;
  registered = true;
  events.on("return.updated", async ({ returnId }) => {
    const r = await prisma.returnRequest.findUnique({
      where: { id: returnId },
      include: { customer: { select: { email: true, firstName: true } }, order: { select: { number: true } }, events: { orderBy: { createdAt: "asc" } } },
    });
    if (!r?.customer?.email) return;
    await messaging.email(r.customer.email, "return.updated", {
      firstName: r.customer.firstName,
      returnNumber: r.number,
      orderNumber: r.order.number,
      status: STATUS_LABELS.return.customer[r.status],
      note: customerStatusNote(r),
    });
  });
}
