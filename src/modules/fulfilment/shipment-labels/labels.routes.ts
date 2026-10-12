import { ModuleRouter, idParam } from "@/core/http/router";
import { shipmentListQuery } from "../shipments/shipments.schemas";
import { labelsController as c } from "./labels.controller";
import { carrierEventBody, carrierParam, labelsBody } from "./labels.schemas";

const pdf = "Returns `application/pdf` (4×6 in pages: sender, recipient, Code128 shipment + order barcodes, tracking, weight, service, signature / insured flags).";

/** asl-admin /shipments: print labels, export. Registered BEFORE shipmentsAdminRoutes so `/export` isn't read as an id. */
export const shipmentLabelsAdminRoutes = new ModuleRouter({ surface: "admin", prefix: "/shipments", tag: "Shipments", defaultAuth: "admin", defaultPermission: "orders.view" })
  .get("/export", { summary: "Shipments CSV (same filters as the list)", query: shipmentListQuery }, c.exportCsv)
  .post("/labels", { summary: "Print labels: one PDF, one 4×6 label per shipment", description: pdf, body: labelsBody }, c.labels)
  .get("/:id/label.pdf", { summary: "One shipment's 4×6 label (id or SHP- number)", description: pdf, params: idParam }, c.label);

/** carrier tracking webhook (stub) — header `X-Carrier-Secret: $CARRIER_WEBHOOK_SECRET` */
export const carrierWebhookRoutes = new ModuleRouter({ surface: "webhooks", prefix: "/carriers", tag: "Webhooks" })
  .post("/:carrier", {
    summary: "Carrier tracking update {trackingNumber, status, location, note, occurredAt} → shipment advance (same rules as staff)",
    description: "Needs `X-Carrier-Secret`. Duplicates, out-of-order events and moves the shipment rules don't allow are ignored (200 with `applied: false` + `reason`).",
    params: carrierParam,
    body: carrierEventBody,
  }, c.carrierEvent);
