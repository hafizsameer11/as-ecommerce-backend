import type { Response } from "express";
import type { Ctx } from "@/core/http/router";
import { sendCsv } from "@/core/http/response";
import type { ShipmentListQuery } from "../shipments/shipments.schemas";
import { labelsService as svc } from "./labels.service";
import type { CarrierEventBody, LabelsBody } from "./labels.schemas";

function sendPdf(res: Response, pdf: { buffer: Buffer; filename: string }) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${pdf.filename.replace(/[^\w.-]/g, "_")}"`);
  res.setHeader("Content-Length", String(pdf.buffer.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf.buffer);
}

export const labelsController = {
  labels: async ({ body, res }: Ctx<LabelsBody>) => sendPdf(res, await svc.labelsPdf(body.ids)),
  label: async ({ params, res }: Ctx<unknown, unknown, { id: string }>) => sendPdf(res, await svc.labelPdf(params.id)),
  exportCsv: async ({ query, res }: Ctx<unknown, ShipmentListQuery>) => sendCsv(res, "shipments", await svc.exportCsv(query)),
  carrierEvent: ({ req, params, body }: Ctx<CarrierEventBody, unknown, { carrier: string }>) =>
    svc.carrierEvent(params.carrier, req.get("x-carrier-secret") ?? undefined, body),
};
