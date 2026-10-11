import type { Response } from "express";
import type { Ctx } from "@/core/http/router";
import { documentsService as svc } from "./documents.service";
import type { EmailInvoiceBody, PrintSlipsBody } from "./documents.schemas";

type Id = { id: string };

/** inline so the browser opens it in a tab; the filename is used when the user saves it */
function sendPdf(res: Response, pdf: { buffer: Buffer; filename: string }, disposition: "inline" | "attachment" = "inline") {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename="${pdf.filename.replace(/[^\w.-]/g, "_")}"`);
  res.setHeader("Content-Length", String(pdf.buffer.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.send(pdf.buffer);
}

export const documentsController = {
  // customer / guest
  myInvoice: async ({ customerId, params, res }: Ctx<unknown, unknown, Id>) => sendPdf(res, await svc.myInvoice(customerId, params.id)),
  invoiceByToken: async ({ params, res }: Ctx<unknown, unknown, { token: string }>) => sendPdf(res, await svc.invoiceByToken(params.token)),

  // admin
  invoice: async ({ params, res }: Ctx<unknown, unknown, Id>) => sendPdf(res, await svc.adminInvoice(params.id)),
  packingSlip: async ({ params, res }: Ctx<unknown, unknown, Id>) => sendPdf(res, await svc.packingSlip(params.id)),
  printSlips: async ({ body, res }: Ctx<PrintSlipsBody>) => sendPdf(res, await svc.packingSlips(body.ids), "attachment"),
  emailInvoice: async ({ params, body, res }: Ctx<EmailInvoiceBody, unknown, Id>) => {
    const r = await svc.emailInvoice(params.id, body.to);
    res.locals.audit = { entityId: r.orderId, summary: `Invoice for ${r.number} emailed to ${r.sentTo}` };
    return r;
  },
};
