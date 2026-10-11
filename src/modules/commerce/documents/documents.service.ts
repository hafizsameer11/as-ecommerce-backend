/**
 * Invoices and packing slips as PDF. Loads the order, maps it to the layout data
 * in documents.render.ts and returns a Buffer (controllers send it).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { formatNaira } from "@/core/utils/money";
import { renderInvoice, renderPackingSlips, type DocLine, type Party, type StoreHeader } from "./documents.render";

const docInclude = {
  items: true,
  pickupLocation: true,
  couponRedemptions: { select: { code: true, discount: true } },
  customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
} satisfies Prisma.OrderInclude;
type DocOrder = Prisma.OrderGetPayload<{ include: typeof docInclude }>;

type Contact = { email?: string; phone?: string; name?: string };
type Address = { fullName?: string; address?: string; apartment?: string; city?: string; state?: string; postal?: string; country?: string; phone?: string };

const PAYMENT_STATUS: Record<string, string> = {
  unpaid: "Unpaid", partially_paid: "Partially paid", paid: "Paid", refunded: "Refunded", partially_refunded: "Partially refunded", failed: "Failed",
};
const PAYMENT_METHOD: Record<string, string> = { card: "Card", bank_transfer: "Bank transfer", paystack: "Card", wallet: "ASL Wallet" };

async function storeHeader(): Promise<StoreHeader & { invoicePrefix: string }> {
  const [p, t] = await Promise.all([settingsService.get("profile"), settingsService.get("tax")]);
  return {
    name: p.displayName, legalName: t.companyLegalName || p.legalName, address: p.address, email: p.supportEmail, phone: p.supportPhone,
    tin: t.registeredTIN, invoicePrefix: t.invoicePrefix,
  };
}

async function vatLabel() {
  const r = await prisma.taxRate.findFirst({ where: { active: true, scope: "country" }, orderBy: { createdAt: "asc" } });
  return r ? `${(r.rateBps / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}%` : "";
}

const lines = (o: DocOrder): DocLine[] =>
  o.items.map((i) => ({
    name: i.name, brand: i.brand, variant: [i.color, i.size].filter(Boolean).join(" · "), sku: i.sku, size: i.size, color: i.color,
    qty: i.qty, unitPrice: i.unitPrice, lineTotal: i.lineTotal,
  }));

function contactOf(o: DocOrder) {
  const c = (o.contact ?? {}) as Contact;
  const a = (o.shippingAddress ?? null) as Address | null;
  const name = o.customer ? fullName(o.customer) : c.name || a?.fullName || "";
  const email = c.email || o.customer?.email || o.guestEmail || "";
  const phone = c.phone || a?.phone || o.customer?.phone || "";
  return { name, email, phone, address: a };
}

const addressLines = (a: Address) => [
  [a.address, a.apartment].filter(Boolean).join(", "),
  [a.city, a.state, a.postal].filter(Boolean).join(", "),
  a.country ?? "",
];

/** delivery block: ship-to address, or the pick-up store */
function destination(o: DocOrder): Party & { label: string } {
  const c = contactOf(o);
  if (o.deliveryMethod === "pickup" && o.pickupLocation) {
    const p = o.pickupLocation;
    return { label: "Pick up in store", name: p.name, lines: [p.address, [p.city, p.state].filter(Boolean).join(", "), p.phone, p.hours] };
  }
  if (c.address) return { label: "Ship to", name: c.address.fullName || c.name, lines: [...addressLines(c.address), c.address.phone || c.phone] };
  return { label: "Ship to", name: c.name, lines: ["No delivery address on file", c.phone] };
}

async function invoiceFor(o: DocOrder) {
  const store = await storeHeader();
  const c = contactOf(o);
  const codes = o.couponRedemptions.map((r) => r.code);
  const buffer = await renderInvoice({
    store,
    invoiceNumber: `${store.invoicePrefix}${o.number}`,
    orderNumber: o.number,
    date: o.placedAt,
    paidAt: o.paidAt,
    billTo: { name: c.name, lines: [c.email, c.phone, ...(c.address ? addressLines(c.address) : [])] },
    deliverTo: destination(o),
    lines: lines(o),
    subtotal: o.subtotal,
    discount: o.discount,
    couponCodes: codes.length ? codes : (o.couponCode?.split(",").filter(Boolean) ?? []),
    shipping: o.shipping,
    shippingLabel: o.deliveryMethod === "pickup" ? "Pick up in store" : o.shippingRateName,
    vatIncluded: o.taxIncluded,
    vatAdded: o.tax,
    vatRateLabel: await vatLabel(),
    walletApplied: o.walletApplied,
    total: o.total,
    amountPaid: o.amountPaid,
    amountRefunded: o.amountRefunded,
    paymentStatus: PAYMENT_STATUS[o.paymentStatus] ?? o.paymentStatus,
    paymentMethod: PAYMENT_METHOD[o.paymentMethod] ?? o.paymentMethod,
  });
  return { buffer, filename: `${store.invoicePrefix}${o.number}.pdf` };
}

async function find(where: Prisma.OrderWhereInput) {
  const o = await prisma.order.findFirst({ where, include: docInclude });
  if (!o) throw ApiError.notFound("Order");
  return o;
}
const byRef = (idOrNumber: string): Prisma.OrderWhereInput => ({ OR: [{ id: idOrNumber }, { number: idOrNumber }] });

export const documentsService = {
  /** customer: own orders only (someone else's order is a plain 404) */
  async myInvoice(customerId: string, idOrNumber: string) {
    return invoiceFor(await find({ customerId, ...byRef(idOrNumber) }));
  },

  /** guest confirmation page (private order access token) */
  async invoiceByToken(token: string) {
    return invoiceFor(await find({ accessToken: token }));
  },

  async adminInvoice(idOrNumber: string) {
    return invoiceFor(await find(byRef(idOrNumber)));
  },

  /** one PDF, one page per order, in the order the ids were given */
  async packingSlips(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await prisma.order.findMany({ where: { OR: [{ id: { in: unique } }, { number: { in: unique } }] }, include: docInclude });
    const ordered = unique.map((id) => rows.find((o) => o.id === id || o.number === id)).filter((o): o is DocOrder => !!o);
    if (!ordered.length) throw ApiError.notFound("Order");
    const store = await storeHeader();
    const buffer = await renderPackingSlips(
      ordered.map((o) => ({
        store,
        orderNumber: o.number,
        date: o.placedAt,
        shipTo: destination(o),
        deliveryNote: o.deliveryMethod === "pickup" ? "Customer collects in store — check ID and order number." : o.shippingRateName,
        lines: lines(o),
        giftMessage: o.giftMessage,
      })),
    );
    const filename = ordered.length === 1 ? `packing-slip-${ordered[0].number}.pdf` : `packing-slips-${new Date().toISOString().slice(0, 10)}.pdf`;
    return { buffer, filename, count: ordered.length, missing: unique.length - ordered.length };
  },

  async packingSlip(idOrNumber: string) {
    const o = await find(byRef(idOrNumber));
    return this.packingSlips([o.id]);
  },

  /** admin "Email invoice": PDF attached to the `order.invoice` template */
  async emailInvoice(idOrNumber: string, to?: string) {
    const o = await find(byRef(idOrNumber));
    const c = contactOf(o);
    const email = to || c.email;
    if (!email) throw ApiError.badRequest("VALIDATION_FAILED", "This order has no email address. Enter one to send the invoice.");
    const { buffer, filename } = await invoiceFor(o);
    const store = await storeHeader();
    await messaging.email(
      email,
      "order.invoice",
      {
        firstName: o.customer?.firstName || c.name.split(" ")[0] || "there", orderNumber: o.number, orderId: o.id,
        invoiceNumber: `${store.invoicePrefix}${o.number}`, total: formatNaira(o.total),
      },
      [{ filename, content: buffer, contentType: "application/pdf" }],
    );
    return { orderId: o.id, number: o.number, sentTo: email, filename };
  },
};
