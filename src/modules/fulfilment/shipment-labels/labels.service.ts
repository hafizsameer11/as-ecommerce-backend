/**
 * Shipping labels (4×6 PDF), shipments CSV export and the carrier tracking webhook.
 * Status moves always go through shipmentsService.advance, so carriers follow the same transition rules
 * (and drive the order status) as staff in /shipments.
 */
import crypto from "node:crypto";
import type { Carrier, ShipmentStatus } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { env } from "@/config/env";
import { logger } from "@/core/utils/logger";
import { toCsv } from "@/core/utils/csv";
import { settingsService } from "@/modules/platform/settings/settings.service";
import { CARRIER_LABEL, customerOf, SHIPMENT_LABEL } from "../shipments/shipments.mapper";
import { shipmentsService } from "../shipments/shipments.service";
import { CARRIERS, type ShipmentListQuery } from "../shipments/shipments.schemas";
import { renderLabels, type LabelData } from "./labels.render";
import type { CarrierEventBody } from "./labels.schemas";

type Address = { fullName?: string; address?: string; apartment?: string; city?: string; state?: string; postal?: string; country?: string; phone?: string };

const labelInclude = {
  order: { select: { number: true, contact: true, guestEmail: true, shippingAddress: true, customer: { select: { firstName: true, lastName: true, email: true, phone: true } } } },
} as const;

async function sender() {
  const p = await settingsService.get("profile");
  return { name: p.displayName || p.legalName, lines: [p.address].filter(Boolean), phone: p.supportPhone };
}

async function findShipments(keys: string[]) {
  const uniq = [...new Set(keys)];
  const rows = await prisma.shipment.findMany({ where: { OR: [{ id: { in: uniq } }, { number: { in: uniq.map((k) => k.toUpperCase()) } }] }, include: labelInclude });
  const missing = uniq.filter((k) => !rows.some((r) => r.id === k || r.number === k.toUpperCase()));
  if (missing.length) throw new ApiError(404, "NOT_FOUND", `Shipment not found: ${missing.join(", ")}.`, { missing });
  // keep the order the staff selected them in
  return uniq.map((k) => rows.find((r) => r.id === k || r.number === k.toUpperCase())!).filter((r, i, all) => all.indexOf(r) === i);
}

type LabelRow = Awaited<ReturnType<typeof findShipments>>[number];

function toLabel(s: LabelRow, from: LabelData["from"]): LabelData {
  const a = (s.order.shippingAddress ?? null) as Address | null;
  const c = customerOf(s.order);
  return {
    shipmentNumber: s.number,
    orderNumber: s.order.number,
    carrier: CARRIER_LABEL[s.carrier],
    service: s.service,
    trackingNumber: s.trackingNumber,
    weightKg: s.weightKg,
    itemsCount: s.itemsCount,
    signatureRequired: s.signatureRequired,
    insured: s.insured,
    createdAt: s.createdAt,
    from,
    to: a
      ? { name: a.fullName || c.name, lines: [[a.address, a.apartment].filter(Boolean).join(", "), [a.city, a.state, a.postal].filter(Boolean).join(", "), a.country ?? ""], phone: a.phone || c.phone }
      : { name: c.name, lines: ["No delivery address on file"], phone: c.phone },
  };
}

/** carrier wording → our status (unknown words are ignored) */
const STATUS_WORDS: [RegExp, ShipmentStatus][] = [
  [/^(label[_ -]?created|created|manifested|pre[_ -]?transit|info[_ -]?received)$/, "label_created"],
  [/^(picked[_ -]?up|pickup|collected|accepted)$/, "picked_up"],
  [/^(in[_ -]?transit|transit|departed|arrived|processed|at[_ -]?hub|customs[_ -]?cleared)$/, "in_transit"],
  [/^(out[_ -]?for[_ -]?delivery|with[_ -]?courier|on[_ -]?vehicle)$/, "out_for_delivery"],
  [/^(delivered)$/, "delivered"],
  [/^(exception|failed[_ -]?attempt|delivery[_ -]?failed|delayed|held|on[_ -]?hold|customs[_ -]?hold)$/, "exception"],
  [/^(returned|return[_ -]?to[_ -]?sender|returned[_ -]?to[_ -]?shipper)$/, "returned"],
];
export const mapCarrierStatus = (s: string) => STATUS_WORDS.find(([re]) => re.test(s.trim().toLowerCase()))?.[1] ?? null;

const carrierOf = (param: string): Carrier | null =>
  (CARRIERS.find((c) => c.toLowerCase() === param.toLowerCase().replace(/[^a-z]/g, "")) as Carrier | undefined) ??
  (/^gig/i.test(param) ? "GIG" : null);

function secretOk(given: string | undefined) {
  const want = env.CARRIER_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export const labelsService = {
  async labelsPdf(ids: string[]) {
    const rows = await findShipments(ids);
    const from = await sender();
    const buffer = await renderLabels(rows.map((s) => toLabel(s, from)));
    return { buffer, filename: rows.length === 1 ? `label-${rows[0].number}.pdf` : `labels-${new Date().toISOString().slice(0, 10)}-${rows.length}.pdf` };
  },

  labelPdf(id: string) {
    return this.labelsPdf([id]);
  },

  /** same filters as the /shipments list */
  async exportCsv(q: ShipmentListQuery) {
    const rows = await prisma.shipment.findMany({
      where: shipmentsService.where(q),
      orderBy: { createdAt: "desc" },
      take: 20_000,
      include: { order: { select: { number: true, contact: true, guestEmail: true, shippingAddress: true, customer: { select: { firstName: true, lastName: true, email: true, phone: true } } } } },
    });
    const whs = new Map((await prisma.warehouse.findMany({ select: { id: true, name: true } })).map((w) => [w.id, w.name]));
    const data = rows.map((s) => {
      const c = customerOf(s.order);
      return {
        number: s.number, order: s.order.number, customer: c.name, email: c.email ?? "", phone: c.phone ?? "",
        carrier: CARRIER_LABEL[s.carrier], service: s.service, tracking: s.trackingNumber ?? "", status: SHIPMENT_LABEL[s.status],
        origin: s.originWarehouseId ? (whs.get(s.originWarehouseId) ?? "") : "", destination: s.destination,
        weightKg: s.weightKg, items: s.itemsCount, declaredValue: s.declaredValue / 100, cost: s.cost / 100,
        insured: s.insured ? "yes" : "no", signatureRequired: s.signatureRequired ? "yes" : "no",
        createdAt: s.createdAt, shippedAt: s.shippedAt, etaAt: s.etaAt, deliveredAt: s.deliveredAt,
      };
    });
    return toCsv(data, [
      "number", "order", "customer", "email", "phone", "carrier", "service", "tracking", "status", "origin", "destination", "weightKg", "items",
      "declaredValue", "cost", "insured", "signatureRequired", "createdAt", "shippedAt", "etaAt", "deliveredAt",
    ], [
      "Shipment", "Order", "Customer", "Email", "Phone", "Carrier", "Service", "Tracking", "Status", "Origin", "Destination", "Weight (kg)", "Items",
      "Declared value (NGN)", "Cost (NGN)", "Insured", "Signature required", "Created", "Shipped", "ETA", "Delivered",
    ]);
  },

  /**
   * POST /webhooks/carriers/:carrier — tracking update from a carrier (stub until a real carrier integration).
   * Duplicates (same tracking + status + time + location) and events older than the last one applied are ignored,
   * as are moves the shipment rules don't allow. Always 200 for a valid secret so carriers don't retry forever.
   */
  async carrierEvent(carrierParam: string, secret: string | undefined, b: CarrierEventBody) {
    if (!env.CARRIER_WEBHOOK_SECRET) throw new ApiError(503, "INTERNAL", "Carrier webhooks are not configured.");
    if (!secretOk(secret)) throw new ApiError(401, "UNAUTHENTICATED", "Invalid carrier secret");
    const carrier = carrierOf(carrierParam);
    if (!carrier) throw ApiError.notFound("Carrier");

    const status = mapCarrierStatus(b.status);
    const s = await prisma.shipment.findFirst({ where: { trackingNumber: b.trackingNumber, carrier }, orderBy: { createdAt: "desc" } });
    const provider = `carrier:${carrier}`;
    const occurredAt = b.occurredAt ?? new Date();
    const eventId = crypto.createHash("sha256").update([b.trackingNumber, b.status.toLowerCase(), occurredAt.toISOString(), b.location ?? ""].join("|")).digest("hex");
    try {
      await prisma.webhookLog.create({
        data: { provider, eventId, type: s ? `shipment:${s.id}` : "shipment:unknown", payload: { ...b, occurredAt: occurredAt.toISOString(), status: b.status, mapped: status } },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return { applied: false, reason: "duplicate" };
      throw e;
    }
    const done = async (applied: boolean, reason: string | null) => {
      await prisma.webhookLog.update({ where: { provider_eventId: { provider, eventId } }, data: { processedAt: new Date(), error: applied ? null : reason } });
      return { applied, reason, shipment: s ? { id: s.id, number: s.number } : null, status };
    };
    if (!s) return done(false, "unknown_tracking_number");
    if (!status) return done(false, "unknown_status");

    // out of order: older than the last carrier event we applied for this shipment
    const last = await prisma.webhookLog.findFirst({ where: { provider, type: `shipment:${s.id}`, processedAt: { not: null }, error: null }, orderBy: { processedAt: "desc" } });
    const lastAt = last ? new Date((last.payload as { occurredAt: string }).occurredAt) : null;
    if (lastAt && occurredAt < lastAt) return done(false, "out_of_order");

    const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: s.id }, select: { status: true } });
    if (fresh.status === status && status !== "in_transit") return done(false, "already_in_status");
    if (!shipmentsService.NEXT[fresh.status].includes(status)) return done(false, `not_allowed_from_${fresh.status}`);
    try {
      await shipmentsService.advance(s.id, { status, location: (b.location || CARRIER_LABEL[carrier]).slice(0, 120), note: b.note?.slice(0, 300) }, `Carrier ${CARRIER_LABEL[carrier]}`);
    } catch (err) {
      // a concurrent update made the move invalid: same as out of order
      if (err instanceof ApiError && err.status === 409) return done(false, "not_allowed");
      logger.error({ err, carrier, tracking: b.trackingNumber }, "carrier event failed");
      // forget it so the carrier's retry is processed
      await prisma.webhookLog.delete({ where: { provider_eventId: { provider, eventId } } }).catch(() => undefined);
      throw err;
    }
    return done(true, null);
  },
};
