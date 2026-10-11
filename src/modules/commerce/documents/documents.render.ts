/**
 * PDF layouts (pdfkit). Pure drawing: takes plain data, returns a Buffer.
 * Helvetica has no "₦" glyph, so we embed DejaVu Sans (src/assets/fonts). If the font
 * file is missing (odd deployment) we fall back to Helvetica and print "NGN".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

type Doc = PDFKit.PDFDocument;

// ── fonts ──
function findFontsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PDF_FONTS_DIR,
    path.resolve(process.cwd(), "src/assets/fonts"),
    path.resolve(process.cwd(), "dist/assets/fonts"),
    path.resolve(here, "../../../assets/fonts"), // src/modules/commerce/documents → src/assets
    path.resolve(here, "assets/fonts"), // bundled dist/
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, "DejaVuSans.ttf"))) ?? null;
}
const FONTS_DIR = findFontsDir();
const REGULAR = FONTS_DIR ? path.join(FONTS_DIR, "DejaVuSans.ttf") : null;
const BOLD = FONTS_DIR && fs.existsSync(path.join(FONTS_DIR, "DejaVuSans-Bold.ttf")) ? path.join(FONTS_DIR, "DejaVuSans-Bold.ttf") : REGULAR;
export const hasNairaGlyph = !!REGULAR;

const money = (kobo: number) => {
  const s = (Math.abs(kobo) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${kobo < 0 ? "-" : ""}${hasNairaGlyph ? "₦" : "NGN "}${s}`;
};
const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Lagos" });

function newDoc(title: string) {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: title, Author: "ASL ORIGINALS" } });
  if (REGULAR && BOLD) {
    doc.registerFont("body", REGULAR);
    doc.registerFont("bold", BOLD);
  } else {
    doc.registerFont("body", "Helvetica");
    doc.registerFont("bold", "Helvetica-Bold");
  }
  doc.font("body");
  return doc;
}

function toBuffer(doc: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// ── shared data shapes ──
export type StoreHeader = { name: string; legalName: string; address: string; email: string; phone: string; tin: string };
export type Party = { name: string; lines: string[] };
export type DocLine = { name: string; brand: string; variant: string; sku: string | null; size: string | null; color: string | null; qty: number; unitPrice: number; lineTotal: number };

export type InvoiceData = {
  store: StoreHeader;
  invoiceNumber: string;
  orderNumber: string;
  date: Date;
  paidAt: Date | null;
  billTo: Party;
  deliverTo: Party & { label: string };
  lines: DocLine[];
  subtotal: number;
  discount: number;
  couponCodes: string[];
  shipping: number;
  shippingLabel: string | null;
  vatIncluded: number;
  vatAdded: number;
  vatRateLabel: string;
  walletApplied: number;
  total: number;
  amountPaid: number;
  amountRefunded: number;
  paymentStatus: string;
  paymentMethod: string;
};

export type SlipData = {
  store: StoreHeader;
  orderNumber: string;
  date: Date;
  shipTo: Party & { label: string };
  deliveryNote: string | null;
  lines: DocLine[];
  giftMessage: string | null;
};

const PAGE_W = 595.28;
const L = 40;
const R = PAGE_W - 40;
const W = R - L;
const GREY = "#666666";
const RULE = "#dddddd";

function header(doc: Doc, store: StoreHeader, title: string, sub: string[]) {
  doc.font("bold").fontSize(18).fillColor("#000").text(store.name, L, 40, { characterSpacing: 2 });
  doc.font("body").fontSize(8.5).fillColor(GREY);
  const info = [store.legalName, store.address, [store.email, store.phone].filter(Boolean).join(" · "), store.tin ? `TIN: ${store.tin}` : ""].filter(Boolean);
  doc.text(info.join("\n"), L, 64, { width: W / 2 });
  doc.font("bold").fontSize(16).fillColor("#000").text(title, L + W / 2, 40, { width: W / 2, align: "right" });
  doc.font("body").fontSize(9).fillColor("#000").text(sub.join("\n"), L + W / 2, 62, { width: W / 2, align: "right" });
  const y = Math.max(doc.y, 64 + info.length * 11) + 14;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(RULE).lineWidth(1).stroke();
  return y + 12;
}

function partyBlock(doc: Doc, x: number, y: number, w: number, label: string, p: Party) {
  doc.font("bold").fontSize(8).fillColor(GREY).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.8 });
  doc.font("bold").fontSize(10).fillColor("#000").text(p.name || "—", x, doc.y + 3, { width: w });
  doc.font("body").fontSize(9).text(p.lines.filter(Boolean).join("\n"), x, doc.y + 1, { width: w });
  return doc.y;
}

function ensureSpace(doc: Doc, y: number, need: number) {
  if (y + need <= doc.page.height - 60) return y;
  doc.addPage();
  return 40;
}

// ── invoice ──
export async function renderInvoice(d: InvoiceData): Promise<Buffer> {
  const doc = newDoc(`Invoice ${d.invoiceNumber}`);
  let y = header(doc, d.store, "INVOICE", [
    `Invoice: ${d.invoiceNumber}`,
    `Order: ${d.orderNumber}`,
    `Date: ${fmtDate(d.date)}`,
    ...(d.paidAt ? [`Paid: ${fmtDate(d.paidAt)}`] : []),
  ]);

  const colW = (W - 20) / 2;
  const b1 = partyBlock(doc, L, y, colW, "Bill to", d.billTo);
  const b2 = partyBlock(doc, L + colW + 20, y, colW, d.deliverTo.label, d.deliverTo);
  y = Math.max(b1, b2) + 18;

  // table
  const cols = { item: L, qty: L + 300, unit: L + 340, total: L + 430 };
  const th = (t: string, x: number, w: number, align: "left" | "right" = "left") =>
    doc.font("bold").fontSize(8).fillColor(GREY).text(t, x, y, { width: w, align, characterSpacing: 0.5 });
  th("ITEM", cols.item, 290);
  th("QTY", cols.qty, 35, "right");
  th("UNIT PRICE", cols.unit, 85, "right");
  th("TOTAL", cols.total, R - cols.total, "right");
  y += 14;
  doc.moveTo(L, y).lineTo(R, y).strokeColor(RULE).stroke();
  y += 6;
  for (const line of d.lines) {
    y = ensureSpace(doc, y, 40);
    doc.font("bold").fontSize(9.5).fillColor("#000").text(line.name, cols.item, y, { width: 290 });
    const meta = [line.brand, line.variant, line.sku ? `SKU ${line.sku}` : ""].filter(Boolean).join(" · ");
    if (meta) doc.font("body").fontSize(8).fillColor(GREY).text(meta, cols.item, doc.y + 1, { width: 290 });
    const rowEnd = doc.y;
    doc.font("body").fontSize(9.5).fillColor("#000");
    doc.text(String(line.qty), cols.qty, y, { width: 35, align: "right" });
    doc.text(money(line.unitPrice), cols.unit, y, { width: 85, align: "right" });
    doc.text(money(line.lineTotal), cols.total, y, { width: R - cols.total, align: "right" });
    y = rowEnd + 8;
    doc.moveTo(L, y - 4).lineTo(R, y - 4).strokeColor("#f0f0f0").stroke();
  }

  // totals
  y = ensureSpace(doc, y + 6, 200);
  const lx = L + W - 260;
  const row = (label: string, value: string, o: { bold?: boolean; grey?: boolean } = {}) => {
    doc.font(o.bold ? "bold" : "body").fontSize(o.bold ? 11 : 9.5).fillColor(o.grey ? GREY : "#000");
    if (!value) {
      doc.text(label, lx, y, { width: 260, align: "right" });
      y = doc.y + 5;
      return;
    }
    doc.text(label, lx, y, { width: 160 });
    const labelEnd = doc.y;
    doc.text(value, lx + 160, y, { width: 100, align: "right" });
    y = Math.max(labelEnd, doc.y) + 5;
  };
  row("Subtotal", money(d.subtotal));
  if (d.discount) row(`Discount${d.couponCodes.length ? ` (${d.couponCodes.join(", ")})` : ""}`, money(-d.discount));
  row(`Shipping${d.shippingLabel ? ` · ${d.shippingLabel}` : ""}`, d.shipping ? money(d.shipping) : "Free");
  if (d.vatAdded) row(`VAT ${d.vatRateLabel}`, money(d.vatAdded));
  doc.moveTo(lx, y).lineTo(R, y).strokeColor(RULE).stroke();
  y += 6;
  row("Total", money(d.total), { bold: true });
  if (d.vatIncluded) row(`VAT ${d.vatRateLabel} included: ${money(d.vatIncluded)}`, "", { grey: true });
  if (d.walletApplied) row("Paid from ASL Wallet", money(d.walletApplied));
  row("Amount paid", money(d.amountPaid));
  if (d.amountRefunded) row("Refunded", money(-d.amountRefunded));
  const due = Math.max(0, d.total - d.amountPaid);
  if (due) row("Balance due", money(due), { bold: true });
  row("Payment status", `${d.paymentStatus}${d.paymentMethod ? ` · ${d.paymentMethod}` : ""}`, { grey: true });

  y = ensureSpace(doc, y + 20, 40);
  doc.font("body").fontSize(8).fillColor(GREY).text(
    `Thank you for shopping with ${d.store.name}. Prices are in Nigerian Naira (NGN). Questions? ${d.store.email}`,
    L, y, { width: W, align: "center" },
  );
  return toBuffer(doc);
}

// ── packing slips (one page per order) ──
export async function renderPackingSlips(slips: SlipData[]): Promise<Buffer> {
  const doc = newDoc(slips.length === 1 ? `Packing slip ${slips[0].orderNumber}` : `Packing slips (${slips.length})`);
  slips.forEach((s, i) => {
    if (i > 0) doc.addPage();
    let y = header(doc, s.store, "PACKING SLIP", [`Order: ${s.orderNumber}`, `Date: ${fmtDate(s.date)}`]);
    const end = partyBlock(doc, L, y, W / 2, s.shipTo.label, s.shipTo);
    if (s.deliveryNote) doc.font("body").fontSize(9).fillColor(GREY).text(s.deliveryNote, L + W / 2 + 20, y, { width: W / 2 - 20 });
    y = Math.max(end, doc.y) + 18;

    const cols = { box: L, item: L + 22, sku: L + 260, size: L + 360, color: L + 410, qty: R - 40 };
    doc.font("bold").fontSize(8).fillColor(GREY);
    doc.text("ITEM", cols.item, y, { width: 230 });
    doc.text("SKU", cols.sku, y, { width: 95 });
    doc.text("SIZE", cols.size, y, { width: 45 });
    doc.text("COLOUR", cols.color, y, { width: 70 });
    doc.text("QTY", cols.qty, y, { width: 40, align: "right" });
    y += 14;
    doc.moveTo(L, y).lineTo(R, y).strokeColor(RULE).stroke();
    y += 8;
    for (const line of s.lines) {
      y = ensureSpace(doc, y, 36);
      doc.rect(cols.box, y, 11, 11).strokeColor("#000").lineWidth(0.8).stroke();
      doc.font("bold").fontSize(9.5).fillColor("#000").text(line.name, cols.item, y, { width: 230 });
      if (line.brand) doc.font("body").fontSize(8).fillColor(GREY).text(line.brand, cols.item, doc.y + 1, { width: 230 });
      const rowEnd = doc.y;
      doc.font("body").fontSize(9).fillColor("#000");
      doc.text(line.sku ?? "—", cols.sku, y, { width: 95 });
      doc.text(line.size ?? "—", cols.size, y, { width: 45 });
      doc.text(line.color ?? "—", cols.color, y, { width: 70 });
      doc.font("bold").fontSize(10).text(String(line.qty), cols.qty, y, { width: 40, align: "right" });
      y = Math.max(rowEnd, y + 14) + 10;
    }
    const units = s.lines.reduce((n, l) => n + l.qty, 0);
    doc.font("body").fontSize(9).fillColor(GREY).text(`${units} item${units === 1 ? "" : "s"} in this parcel`, L, y + 4, { width: W, align: "right" });
    y = doc.y + 16;
    if (s.giftMessage) {
      y = ensureSpace(doc, y, 80);
      doc.font("bold").fontSize(8).fillColor(GREY).text("GIFT MESSAGE", L, y);
      doc.font("body").fontSize(10).fillColor("#000").text(s.giftMessage, L, doc.y + 4, { width: W });
      y = doc.y + 16;
    }
    y = ensureSpace(doc, y, 40);
    doc.font("body").fontSize(8).fillColor(GREY).text("Packed by: ____________________     Checked by: ____________________", L, y + 10, { width: W });
  });
  return toBuffer(doc);
}
