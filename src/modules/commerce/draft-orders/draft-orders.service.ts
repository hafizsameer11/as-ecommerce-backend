/**
 * Draft orders (asl-admin /drafts): quotes, holds and manual carts prepared by staff.
 * draft → sent (pay link emailed, valid 7 days) → converted (a real, paid order exists).
 * Two ways to convert, sharing `convertInTx`:
 *  - the customer pays the link (payments handler "draft_order", inside the payment transaction)
 *  - staff confirm an offline payment (POST /admin/draft-orders/:id/convert)
 */
import crypto from "node:crypto";
import type { CheckoutPaymentMethod, DraftOrder, Payment, Prisma } from "@/generated/prisma/client";
import { prisma, type Tx } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { pageMeta, paging } from "@/core/http/pagination";
import { withMeta } from "@/core/http/router";
import { events } from "@/core/events/bus";
import { formatNaira } from "@/core/utils/money";
import { logger } from "@/core/utils/logger";
import { nextSequence, formatters } from "@/core/utils/sequence";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { inventoryService } from "@/modules/inventory/inventory.service";
import { taxService } from "@/modules/fulfilment/tax/tax.service";
import { paymentsService } from "@/modules/payments/payments/payments.service";
import { messaging } from "@/modules/marketing/messaging/messaging.service";
import { productInclude } from "@/modules/catalog/products/product.mapper";
import { pickVariant } from "@/modules/commerce/carts/carts.service";
import { ordersService, newAccessToken } from "@/modules/commerce/orders/orders.service";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { linesOf, payUrl, toAdminDraft, toPayView, type DraftLine } from "./draft-orders.mapper";
import type { ConvertDraftBody, CreateDraftBody, DraftItemInput, DraftListQuery, PayDraftBody, UpdateDraftBody } from "./draft-orders.schemas";

const PAY_LINK_DAYS = 7;
const TARGET = "draft_order";
const customerSelect = { id: true, firstName: true, lastName: true, email: true } as const;

const byRef = (idOrNumber: string): Prisma.DraftOrderWhereInput => ({ OR: [{ id: idOrNumber }, { number: idOrNumber }] });

async function load(idOrNumber: string) {
  const d = await prisma.draftOrder.findFirst({ where: byRef(idOrNumber), include: { customer: { select: customerSelect } } });
  if (!d) throw ApiError.notFound("Draft order");
  return d;
}

async function view(idOrNumber: string) {
  const d = await load(idOrNumber);
  const order = d.orderId ? await prisma.order.findUnique({ where: { id: d.orderId }, select: { id: true, number: true } }) : null;
  return toAdminDraft({ ...d, order });
}

/** catalogue lines are priced from the product (unless overridden); custom lines need name + price */
async function resolveItems(items: DraftItemInput[]): Promise<DraftLine[]> {
  const out: DraftLine[] = [];
  for (const i of items) {
    if (!i.productId) {
      out.push({
        productId: null, variantId: null, sku: null, name: i.name!, brand: i.brand ?? "", size: i.size ?? null, color: i.color ?? null,
        qty: i.qty, unitPrice: i.unitPrice!, imageUrl: i.imageUrl ?? null, custom: true,
      });
      continue;
    }
    const p = await prisma.product.findFirst({ where: { OR: [{ id: i.productId }, { handle: i.productId }] }, include: productInclude });
    if (!p) throw ApiError.notFound(`Product "${i.productId}"`);
    if (p.priceOnRequest && i.unitPrice === undefined) throw ApiError.badRequest("VALIDATION_FAILED", `${p.name} is price-on-request. Enter a unit price.`);
    const coloured = p.variants.some((v) => v.color);
    const color = coloured ? (i.color ?? p.colors[0]?.name ?? null) : null;
    const v = p.variants.length ? pickVariant(p, i.size ?? null, color) : null;
    out.push({
      productId: p.id, variantId: v?.id ?? null, sku: v?.sku ?? null, name: i.name ?? p.name, brand: i.brand ?? p.brand.name,
      size: v?.size ?? i.size ?? null, color: v?.color ?? color, qty: i.qty,
      unitPrice: i.unitPrice ?? v?.price ?? p.price,
      imageUrl: i.imageUrl ?? p.images.find((img) => img.color && img.color === color)?.url ?? p.images[0]?.url ?? null,
      custom: false,
    });
  }
  return out;
}

function totals(lines: DraftLine[], discount: number, shipping: number) {
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  if (discount > subtotal) throw ApiError.badRequest("VALIDATION_FAILED", `The discount can't be more than the items (${formatNaira(subtotal)}).`);
  return { subtotal, discount, shipping, total: subtotal - discount + shipping };
}

async function customerInfo(customerId: string) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { ...customerSelect, phone: true } });
  if (!c) throw ApiError.notFound("Customer");
  return c;
}

async function lockDraft(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM \`DraftOrder\` WHERE id = ${id} FOR UPDATE`;
  return tx.draftOrder.findUnique({ where: { id } });
}

/**
 * Inside a transaction: turn the draft into a real order (channel "draft"), hold the stock for
 * catalogue lines and mark the draft converted. The caller then records the money (applyPayment
 * commits the sale). `strictStock` = refuse when stock is short (staff action); a customer who
 * already paid still gets the order, with an internal note for the team.
 */
async function convertInTx(tx: Tx, d: DraftOrder, o: { paymentMethod: CheckoutPaymentMethod; strictStock: boolean; actor: string }) {
  if (d.status === "converted") throw ApiError.conflict("INVALID_STATE", "This draft is already an order.");
  const lines = linesOf(d);
  const customer = d.customerId ? await tx.customer.findUnique({ where: { id: d.customerId }, select: { email: true, phone: true } }) : null;
  const email = (d.email || customer?.email || "").toLowerCase();
  const tax = await taxService.compute({ country: "NG", productsAmount: d.subtotal - d.discount, shippingAmount: d.shipping, customerEmail: email || undefined });

  const number = formatters.order(await nextSequence(tx, "order", 10249));
  const order = await tx.order.create({
    data: {
      number,
      customerId: d.customerId,
      guestEmail: d.customerId ? null : email || null,
      accessToken: newAccessToken(),
      channel: "draft",
      deliveryMethod: "ship",
      paymentMethod: o.paymentMethod,
      subtotal: d.subtotal, discount: d.discount, shipping: d.shipping,
      // the draft total is the agreed price: VAT is reported inside it, never added on top
      tax: 0, taxIncluded: tax.included + tax.added,
      total: d.total,
      contact: { email, phone: customer?.phone ?? "", name: d.customerName },
      shippingRateName: d.shipping ? "Arranged by staff" : null,
      items: {
        create: lines.map((l) => ({
          productId: l.productId, variantId: l.variantId, sku: l.sku, name: l.name, brand: l.brand || "—", imageUrl: l.imageUrl,
          size: l.size, color: l.color, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.unitPrice * l.qty,
        })),
      },
    },
  });
  await ordersService.addEvent(tx, order.id, "placed", "Order placed", { detail: `From draft ${d.number} · ${formatNaira(d.total)}`, actor: o.actor });

  // stock: catalogue lines only (custom lines have no variant), pre-order items are made to order
  const variantIds = lines.filter((l) => l.variantId).map((l) => l.variantId!);
  const preOrder = new Set(
    (await tx.productVariant.findMany({ where: { id: { in: variantIds }, product: { availability: "pre_order" } }, select: { id: true } })).map((v) => v.id),
  );
  const stockLines = lines.filter((l) => l.variantId && !preOrder.has(l.variantId)).map((l) => ({ variantId: l.variantId!, qty: l.qty }));
  const ref = ordersService.STOCK_REF(order.id);
  try {
    await inventoryService.reserve(tx, stockLines, ref);
  } catch (e) {
    if (o.strictStock || !(e instanceof ApiError) || e.code !== "OUT_OF_STOCK") throw e;
    // already paid: keep the order, hold what we can, flag the rest for the team
    const short: string[] = [];
    for (const line of stockLines) {
      try {
        await inventoryService.reserve(tx, [line], ref);
      } catch {
        short.push(lines.find((l) => l.variantId === line.variantId)?.sku ?? line.variantId);
      }
    }
    await ordersService.addEvent(tx, order.id, "note", "Stock short for a paid draft order", { detail: `Check inventory: ${short.join(", ")}`, internal: true });
    logger.warn({ order: number, short }, "draft order converted with stock short");
  }

  await tx.draftOrder.update({ where: { id: d.id }, data: { status: "converted", orderId: order.id } });
  return order;
}

export const draftOrdersService = {
  convertInTx,

  // ── admin ──
  async list(q: DraftListQuery) {
    const tabs: Record<DraftListQuery["tab"], Prisma.DraftOrderWhereInput> = { all: {}, draft: { status: "draft" }, sent: { status: "sent" }, converted: { status: "converted" } };
    const and: Prisma.DraftOrderWhereInput[] = [tabs[q.tab]];
    if (q.q) and.push({ OR: [{ number: { contains: q.q } }, { customerName: { contains: q.q } }, { email: { contains: q.q } }, { note: { contains: q.q } }] });
    const where = { AND: and };
    const sort: Prisma.DraftOrderOrderByWithRelationInput = q.sort === "total" ? { total: "asc" } : q.sort === "-total" ? { total: "desc" } : q.sort === "createdAt" ? { createdAt: "asc" } : { createdAt: "desc" };
    const [rows, total, groups] = await Promise.all([
      prisma.draftOrder.findMany({ where, ...paging(q), orderBy: sort, include: { customer: { select: customerSelect } } }),
      prisma.draftOrder.count({ where }),
      prisma.draftOrder.groupBy({ by: ["status"], _count: { _all: true }, _sum: { total: true } }),
    ]);
    const orderIds = rows.map((r) => r.orderId).filter((x): x is string => !!x);
    const orders = orderIds.length ? await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : [];
    const c = (s?: string) => groups.filter((g) => !s || g.status === s).reduce((n, g) => n + g._count._all, 0);
    const value = groups.reduce((n, g) => n + (g._sum.total ?? 0), 0);
    const all = c();
    return withMeta(
      rows.map((d) => toAdminDraft({ ...d, order: orders.find((x) => x.id === d.orderId) ?? null })),
      {
        ...pageMeta(q, total),
        tabs: { all, draft: c("draft"), sent: c("sent"), converted: c("converted") },
        kpis: { total: all, sent: c("sent"), converted: c("converted"), combinedValue: value, avgQuote: all ? Math.round(value / all) : 0 },
      },
    );
  },

  get: view,

  async create(b: CreateDraftBody, actor: string) {
    const lines = await resolveItems(b.items);
    const t = totals(lines, b.discount, b.shipping);
    const customer = b.customerId ? await customerInfo(b.customerId) : null;
    const d = await prisma.$transaction(async (tx) =>
      tx.draftOrder.create({
        data: {
          number: formatters.draft(await nextSequence(tx, "draft", 3500)),
          customerId: customer?.id ?? null,
          customerName: b.customerName ?? (customer ? fullName(customer) : ""),
          email: b.email ?? customer?.email ?? null,
          items: lines as unknown as Prisma.InputJsonValue,
          ...t,
          note: b.note || null,
          createdBy: actor,
        },
      }),
    );
    return view(d.id);
  },

  async update(idOrNumber: string, b: UpdateDraftBody) {
    const d = await load(idOrNumber);
    if (d.status === "converted") throw ApiError.conflict("INVALID_STATE", "This draft is already an order and can't be changed.");
    const data: Prisma.DraftOrderUpdateInput = {};
    if (b.customerId !== undefined) {
      if (b.customerId) {
        const c = await customerInfo(b.customerId);
        data.customer = { connect: { id: c.id } };
        data.customerName = b.customerName ?? fullName(c);
        data.email = b.email ?? c.email;
      } else data.customer = { disconnect: true };
    }
    if (b.customerName !== undefined) data.customerName = b.customerName;
    if (b.email !== undefined) data.email = b.email;
    if (b.note !== undefined) data.note = b.note;
    const lines = b.items ? await resolveItems(b.items) : linesOf(d);
    if (b.items || b.discount !== undefined || b.shipping !== undefined) {
      Object.assign(data, totals(lines, b.discount ?? d.discount, b.shipping ?? d.shipping));
      data.items = lines as unknown as Prisma.InputJsonValue;
    }
    await prisma.$transaction(async (tx) => {
      await tx.draftOrder.update({ where: { id: d.id }, data });
      // the amount may have changed: a payment page opened before the edit must not be used
      await tx.payment.updateMany({ where: { targetType: TARGET, targetId: d.id, status: "pending" }, data: { status: "abandoned" } });
    });
    return view(d.id);
  },

  async duplicate(idOrNumber: string, actor: string) {
    const d = await load(idOrNumber);
    const copy = await prisma.$transaction(async (tx) =>
      tx.draftOrder.create({
        data: {
          number: formatters.draft(await nextSequence(tx, "draft", 3500)),
          customerId: d.customerId, customerName: d.customerName, email: d.email,
          items: d.items as Prisma.InputJsonValue, subtotal: d.subtotal, discount: d.discount, shipping: d.shipping, total: d.total,
          note: d.note, createdBy: actor,
        },
      }),
    );
    return view(copy.id);
  },

  async remove(idOrNumber: string) {
    const d = await load(idOrNumber);
    if (d.status === "converted") throw ApiError.conflict("INVALID_STATE", "Converted drafts are kept with their order and can't be deleted.");
    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({ where: { targetType: TARGET, targetId: d.id, status: "pending" }, data: { status: "abandoned" } });
      await tx.draftOrder.delete({ where: { id: d.id } });
    });
    return { deleted: true, id: d.id, number: d.number };
  },

  /** email a pay link (new token each time: older links stop working) */
  async send(idOrNumber: string, email?: string) {
    const d = await load(idOrNumber);
    if (d.status === "converted") throw ApiError.conflict("INVALID_STATE", "This draft is already an order.");
    const to = email ?? d.email ?? d.customer?.email;
    if (!to) throw ApiError.badRequest("VALIDATION_FAILED", "Add the customer's email address to send the pay link.");
    if (d.total <= 0) throw ApiError.badRequest("VALIDATION_FAILED", "Nothing to pay on this draft. Convert it instead.");
    const payToken = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + PAY_LINK_DAYS * 86_400_000);
    await prisma.draftOrder.update({ where: { id: d.id }, data: { status: "sent", payToken, expiresAt, sentAt: new Date(), email: to } });
    const link = payUrl(payToken);
    await messaging.email(to, "draft.pay_link", {
      customerName: d.customerName || "there", firstName: (d.customerName || "there").split(" ")[0], draftNumber: d.number,
      total: formatNaira(d.total), payUrl: link, expiresAt: expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    });
    return { ...(await view(d.id)), payUrl: link };
  },

  /** staff confirm a payment taken outside the gateway (transfer, cash, POS) → real paid order */
  async convert(idOrNumber: string, b: ConvertDraftBody, actor: string) {
    const found = await load(idOrNumber);
    const res = await prisma.$transaction(async (tx) => {
      const d = await lockDraft(tx, found.id);
      if (!d) throw ApiError.notFound("Draft order");
      const order = await convertInTx(tx, d, { paymentMethod: b.method === "pos" ? "card" : "bank_transfer", strictStock: true, actor });
      await tx.payment.updateMany({ where: { targetType: TARGET, targetId: d.id, status: "pending" }, data: { status: "abandoned" } });
      const via = `${b.method} · confirmed by ${actor}`;
      if (d.total <= 0) {
        await tx.order.update({ where: { id: order.id }, data: { status: "paid", paymentStatus: "paid", paidAt: new Date() } });
        await ordersService.addEvent(tx, order.id, "payment_confirmed", "Payment confirmed", { detail: "Nothing to pay" });
        await inventoryService.commitSale(tx, ordersService.STOCK_REF(order.id));
        return { orderId: order.id, paid: order.id };
      }
      await tx.payment.create({
        data: {
          reference: `MANUAL_${b.reference}_${d.number}`.slice(0, 190), provider: "manual", purpose: "draft_order", method: b.method, status: "succeeded",
          amount: d.total, email: (d.email || "unknown@asloriginals.com").toLowerCase(), customerId: d.customerId, orderId: order.id,
          targetType: TARGET, targetId: d.id, paidAt: new Date(), providerData: { note: b.note, by: actor, reference: b.reference },
        },
      });
      const paid = await ordersService.applyPayment(tx, order.id, d.total, via);
      return { orderId: order.id, paid };
    });
    events.emit("order.placed", { orderId: res.orderId });
    ordersService.afterPaid(res.paid);
    return view(found.id);
  },

  // ── customer pay link (public) ──
  async findPayable(token: string) {
    const d = await prisma.draftOrder.findUnique({ where: { payToken: token } });
    // same 404 for unknown / expired / already paid, so tokens can't be probed
    if (!d || d.status !== "sent" || !d.expiresAt || d.expiresAt < new Date()) throw ApiError.notFound("Payment link");
    return d;
  },

  async payView(token: string) {
    const d = await this.findPayable(token);
    const p = await settingsService.get("profile");
    return toPayView(d, { name: p.displayName, supportEmail: p.supportEmail });
  },

  async pay(token: string, b: PayDraftBody) {
    const d = await this.findPayable(token);
    if (d.total <= 0) throw ApiError.badRequest("VALIDATION_FAILED", "Nothing to pay.");
    const email = d.email || (await settingsService.get("profile")).supportEmail;
    await prisma.payment.updateMany({ where: { targetType: TARGET, targetId: d.id, status: "pending" }, data: { status: "abandoned" } });
    return paymentsService.start({
      purpose: "draft_order", amount: d.total, email, customerId: d.customerId, targetType: TARGET, targetId: d.id, method: b.method, returnUrl: b.returnUrl,
    });
  },
};

// card / transfer payments for a draft's pay link
paymentsService.register("draft_order", {
  async succeeded(tx, p: Payment) {
    const d = p.targetId ? await lockDraft(tx, p.targetId) : null;
    if (!d || d.status === "converted") {
      // paid twice, or staff converted it offline meanwhile: never keep money we shouldn't
      await paymentsService.refund(tx, p.id, p.amount, d ? "Draft order already paid" : "Draft order no longer exists", "system");
      logger.warn({ reference: p.reference, draft: p.targetId }, "draft payment refunded");
      return;
    }
    const order = await convertInTx(tx, d, { paymentMethod: p.method === "bank_transfer" ? "bank_transfer" : "card", strictStock: false, actor: "customer" });
    await tx.payment.update({ where: { id: p.id }, data: { orderId: order.id } });
    let amount = p.amount;
    if (amount > d.total) {
      // the draft was edited down after the payment page opened
      await paymentsService.refund(tx, p.id, amount - d.total, "Draft total changed", "system");
      amount = d.total;
    }
    const paid = await ordersService.applyPayment(tx, order.id, amount, `${p.method} · ${p.reference}`, p.id);
    return () => {
      events.emit("order.placed", { orderId: order.id });
      ordersService.afterPaid(paid);
    };
  },
});
