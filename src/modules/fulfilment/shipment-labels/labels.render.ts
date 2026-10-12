/**
 * 4×6 inch shipping labels (pdfkit, one page per shipment) with Code128 barcodes (bwip-js, pure JS).
 * Uses the same DejaVu fonts as invoices (src/assets/fonts); falls back to Helvetica when missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js/node";

const W = 288; // 4 in
const H = 432; // 6 in
const M = 12;

function findFontsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PDF_FONTS_DIR,
    path.resolve(process.cwd(), "src/assets/fonts"),
    path.resolve(process.cwd(), "dist/assets/fonts"),
    path.resolve(here, "../../../assets/fonts"),
    path.resolve(here, "assets/fonts"),
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, "DejaVuSans.ttf"))) ?? null;
}
const FONTS_DIR = findFontsDir();
const REGULAR = FONTS_DIR ? path.join(FONTS_DIR, "DejaVuSans.ttf") : null;
const BOLD = FONTS_DIR && fs.existsSync(path.join(FONTS_DIR, "DejaVuSans-Bold.ttf")) ? path.join(FONTS_DIR, "DejaVuSans-Bold.ttf") : REGULAR;

export type LabelParty = { name: string; lines: string[]; phone?: string | null };
export type LabelData = {
  shipmentNumber: string;
  orderNumber: string;
  carrier: string;
  service: string;
  trackingNumber: string | null;
  weightKg: number;
  itemsCount: number;
  signatureRequired: boolean;
  insured: boolean;
  createdAt: Date;
  from: LabelParty;
  to: LabelParty;
};

/** Code128 PNG; text printed separately so it uses our font */
export const code128 = (text: string, height = 12) =>
  bwipjs.toBuffer({ bcid: "code128", text, scale: 3, height, includetext: false, paddingwidth: 0, paddingheight: 0 });

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Lagos" });

function drawLabel(doc: PDFKit.PDFDocument, l: LabelData, codes: { shipment: Buffer; order: Buffer }) {
  const inner = W - 2 * M;
  doc.lineWidth(1).strokeColor("#000").fillColor("#000");
  doc.rect(M / 2, M / 2, W - M, H - M).stroke();

  // sender
  let y = M;
  doc.font("bold").fontSize(6).text("FROM", M, y);
  doc.font("bold").fontSize(8).text(l.from.name, M + 30, y, { width: inner - 30 });
  y = doc.y;
  doc.font("body").fontSize(7).text([...l.from.lines, l.from.phone].filter(Boolean).join(" · "), M + 30, y, { width: inner - 30 });
  y = doc.y + 4;
  doc.moveTo(M / 2, y).lineTo(W - M / 2, y).stroke();

  // carrier + service, flags
  y += 4;
  doc.font("bold").fontSize(16).text(l.carrier.toUpperCase(), M, y, { width: inner * 0.55 });
  doc.font("body").fontSize(8).text(l.service, M, doc.y, { width: inner * 0.55 });
  const flags = [l.signatureRequired ? "SIGNATURE REQUIRED" : null, l.insured ? "INSURED" : null].filter(Boolean) as string[];
  let fy = y;
  for (const f of flags) {
    const fw = inner * 0.42;
    doc.rect(W - M - fw, fy, fw, 14).fill("#000");
    doc.fillColor("#fff").font("bold").fontSize(7).text(f, W - M - fw, fy + 4, { width: fw, align: "center" });
    doc.fillColor("#000");
    fy += 17;
  }
  y = Math.max(doc.y, fy) + 4;
  doc.moveTo(M / 2, y).lineTo(W - M / 2, y).stroke();

  // recipient
  y += 6;
  doc.font("bold").fontSize(7).text("SHIP TO", M, y);
  doc.font("bold").fontSize(13).text(l.to.name || "-", M, doc.y + 2, { width: inner });
  doc.font("body").fontSize(10);
  for (const line of l.to.lines.filter(Boolean)) doc.text(line, M, doc.y, { width: inner });
  if (l.to.phone) doc.font("bold").fontSize(9).text(`Tel: ${l.to.phone}`, M, doc.y + 2, { width: inner });
  y = Math.max(doc.y + 6, 200);
  doc.moveTo(M / 2, y).lineTo(W - M / 2, y).stroke();

  // barcodes
  y += 8;
  doc.font("bold").fontSize(7).text("SHIPMENT", M, y);
  doc.image(codes.shipment, M, y + 10, { fit: [inner, 44], align: "center" });
  doc.font("bold").fontSize(10).text(l.shipmentNumber, M, y + 57, { width: inner, align: "center" });
  y += 74;
  doc.font("bold").fontSize(7).text("ORDER", M, y);
  doc.image(codes.order, M, y + 10, { fit: [inner, 34], align: "center" });
  doc.font("bold").fontSize(9).text(l.orderNumber, M, y + 47, { width: inner, align: "center" });
  y += 62;
  doc.moveTo(M / 2, y).lineTo(W - M / 2, y).stroke();

  // details
  y += 6;
  const col = inner / 2;
  const cell = (label: string, value: string, x: number, yy: number) => {
    doc.font("body").fontSize(6).text(label.toUpperCase(), x, yy, { width: col - 4 });
    doc.font("bold").fontSize(9).text(value, x, yy + 8, { width: col - 4 });
  };
  cell("Tracking", l.trackingNumber || "Not assigned", M, y);
  cell("Weight", l.weightKg > 0 ? `${l.weightKg.toLocaleString("en-NG", { maximumFractionDigits: 2 })} kg` : "-", M + col, y);
  cell("Items", String(l.itemsCount), M, y + 26);
  cell("Date", fmtDate(l.createdAt), M + col, y + 26);
}

/** one PDF, one 4×6 page per label */
export async function renderLabels(labels: LabelData[]): Promise<Buffer> {
  const codes = await Promise.all(labels.map(async (l) => ({ shipment: await code128(l.shipmentNumber), order: await code128(l.orderNumber, 9) })));
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: labels.length === 1 ? `Label ${labels[0].shipmentNumber}` : "Shipping labels", Author: "ASL ORIGINALS" } });
  if (REGULAR && BOLD) {
    doc.registerFont("body", REGULAR);
    doc.registerFont("bold", BOLD);
  } else {
    doc.registerFont("body", "Helvetica");
    doc.registerFont("bold", "Helvetica-Bold");
  }
  labels.forEach((l, i) => {
    doc.addPage({ size: [W, H], margin: 0 });
    drawLabel(doc, l, codes[i]);
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}
