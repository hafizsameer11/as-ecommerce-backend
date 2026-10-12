/**
 * ReportData → file. Money columns are printed in naira (kobo / 100) since these files are opened by
 * people in Excel / a PDF viewer; the API itself stays in kobo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { toCsv } from "@/core/utils/csv";
import type { Column, ReportData, Row } from "./reports.generators";
import type { ReportFormat } from "./reports.schemas";

export const CONTENT_TYPES: Record<ReportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

const naira = (k: number) => Math.round(k) / 100;
const lagosDate = (d: Date) => new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
const lagosDateTime = (d: Date) => new Date(d.getTime() + 3_600_000).toISOString().slice(0, 16).replace("T", " ");

/** plain cell value for CSV / PDF */
function text(c: Column, v: Row[string]): string {
  if (v === null || v === undefined || v === "") return "";
  switch (c.type) {
    case "money":
      return naira(Number(v)).toFixed(2);
    case "pct":
      return `${(Number(v) * 100).toFixed(1)}%`;
    case "date":
      return v instanceof Date ? lagosDate(v) : String(v);
    case "datetime":
      return v instanceof Date ? lagosDateTime(v) : String(v);
    case "bool":
      return v ? "Yes" : "No";
    default:
      return String(v);
  }
}
const header = (c: Column) => (c.type === "money" ? `${c.label} (NGN)` : c.label);

/** totals row: label in the first column, sums in numeric columns */
function totalsLine(d: ReportData): Row | null {
  if (!d.totals || !d.rows.length) return null;
  const first = d.columns[0].key;
  return Object.fromEntries(d.columns.map((c) => [c.key, c.key === first ? String(d.totals!._label ?? "Total") : c.type === "text" ? "" : (d.totals![c.key] ?? "")]));
}

function csv(d: ReportData) {
  // numbers stay numbers (a text cell starting with "-" would be escaped as a formula)
  const cell = (c: Column, v: Row[string]) =>
    v === null || v === undefined || v === "" ? "" : c.type === "money" ? naira(Number(v)) : c.type === "int" ? Number(v) : text(c, v);
  const lines = [...d.rows, ...(totalsLine(d) ? [totalsLine(d)!] : [])].map((r) => Object.fromEntries(d.columns.map((c) => [c.key, cell(c, r[c.key])])));
  return Buffer.from("\uFEFF" + toCsv(lines, d.columns.map((c) => c.key), d.columns.map(header)), "utf8");
}

async function xlsx(d: ReportData) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ASL ORIGINALS";
  wb.created = new Date();
  const ws = wb.addWorksheet(d.title.slice(0, 31), { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = d.columns.map((c) => ({
    header: header(c), key: c.key, width: c.width ?? (c.type === "money" ? 15 : 12),
    style: c.type === "money" ? { numFmt: "#,##0.00" } : c.type === "pct" ? { numFmt: "0.0%" } : c.type === "date" ? { numFmt: "yyyy-mm-dd" } : c.type === "datetime" ? { numFmt: "yyyy-mm-dd hh:mm" } : {},
  }));
  ws.getRow(1).font = { bold: true };
  const cell = (c: Column, v: Row[string]) => {
    if (v === null || v === undefined) return null;
    if (c.type === "money") return naira(Number(v));
    if (c.type === "date" || c.type === "datetime") return v instanceof Date ? new Date(v.getTime() + 3_600_000) : v; // show Lagos wall time
    if (c.type === "bool") return v ? "Yes" : "No";
    return v as string | number;
  };
  for (const r of d.rows) ws.addRow(Object.fromEntries(d.columns.map((c) => [c.key, cell(c, r[c.key])])));
  const t = totalsLine(d);
  if (t) ws.addRow(Object.fromEntries(d.columns.map((c) => [c.key, c.type === "text" ? t[c.key] : cell(c, t[c.key] === "" ? null : t[c.key])]))).font = { bold: true };
  const about = wb.addWorksheet("About");
  about.addRows([["Report", d.title], ["Period", d.period ?? ""], ["Generated", lagosDateTime(new Date()) + " (Lagos)"], ["Rows", d.rows.length], ["Money", "Naira (NGN)"]]);
  about.getColumn(1).font = { bold: true };
  about.getColumn(1).width = 12;
  about.getColumn(2).width = 40;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PDF (same embedded font as invoices: DejaVu has the ₦ glyph) ──
function fontsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.PDF_FONTS_DIR,
    path.resolve(process.cwd(), "src/assets/fonts"),
    path.resolve(process.cwd(), "dist/assets/fonts"),
    path.resolve(here, "../../../assets/fonts"),
    path.resolve(here, "assets/fonts"),
  ].filter(Boolean).find((d) => fs.existsSync(path.join(d as string, "DejaVuSans.ttf"))) as string | undefined;
}
const PDF_ROW_LIMIT = 2_000;

function pdf(d: ReportData): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32, info: { Title: d.title, Author: "ASL ORIGINALS" } });
  const dir = fontsDir();
  doc.registerFont("body", dir ? path.join(dir, "DejaVuSans.ttf") : "Helvetica");
  doc.registerFont("bold", dir && fs.existsSync(path.join(dir, "DejaVuSans-Bold.ttf")) ? path.join(dir, "DejaVuSans-Bold.ttf") : dir ? path.join(dir, "DejaVuSans.ttf") : "Helvetica-Bold");
  const out = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = doc.page.margins.left;
  const usable = doc.page.width - left - doc.page.margins.right;
  const weights = d.columns.map((c) => c.width ?? (c.type === "money" ? 13 : 9));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalW) * usable);
  const size = d.columns.length > 12 ? 6.5 : d.columns.length > 8 ? 7.5 : 8.5;
  const rowH = size + 6;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 14;

  const line = (values: string[], font: "body" | "bold", y: number) => {
    let x = left;
    doc.font(font).fontSize(size);
    values.forEach((v, i) => {
      const c = d.columns[i];
      const numeric = c.type === "money" || c.type === "int" || c.type === "pct";
      doc.text(v, x + 2, y, { width: widths[i] - 4, height: rowH, lineBreak: false, ellipsis: true, align: numeric ? "right" : "left" });
      x += widths[i];
    });
  };
  const head = () => {
    const y = doc.y;
    doc.rect(left, y - 2, usable, rowH).fill("#f1f1f1").fillColor("#000");
    line(d.columns.map(header), "bold", y);
    doc.y = y + rowH;
  };

  doc.font("bold").fontSize(16).text(d.title, left, doc.page.margins.top);
  doc.font("body").fontSize(9).fillColor("#555").text([d.period, `Generated ${lagosDateTime(new Date())} (Lagos)`, "Amounts in NGN"].filter(Boolean).join("  ·  "));
  doc.fillColor("#000").moveDown(0.8);
  head();
  const rows = d.rows.slice(0, PDF_ROW_LIMIT);
  for (const r of rows) {
    if (doc.y + rowH > bottom()) {
      doc.addPage();
      head();
    }
    line(d.columns.map((c) => text(c, r[c.key])), "body", doc.y);
    doc.y += rowH;
  }
  const t = totalsLine(d);
  if (t) {
    if (doc.y + rowH > bottom()) {
      doc.addPage();
      head();
    }
    doc.moveTo(left, doc.y).lineTo(left + usable, doc.y).stroke("#999");
    line(d.columns.map((c) => text(c, t[c.key])), "bold", doc.y + 2);
    doc.y += rowH;
  }
  if (!d.rows.length) doc.font("body").fontSize(10).text("No data for this period.", left, doc.y + 6);
  if (d.rows.length > PDF_ROW_LIMIT) doc.font("body").fontSize(8).fillColor("#a00").text(`Showing the first ${PDF_ROW_LIMIT} of ${d.rows.length} rows — download CSV or XLSX for everything.`, left, doc.y + 6);
  doc.end();
  return out;
}

export async function renderReport(d: ReportData, format: ReportFormat): Promise<Buffer> {
  if (format === "csv") return csv(d);
  if (format === "xlsx") return xlsx(d);
  return pdf(d);
}
