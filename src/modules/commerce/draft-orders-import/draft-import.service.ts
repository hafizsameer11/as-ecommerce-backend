/**
 * Draft orders CSV import (asl-admin /drafts → Import).
 * Columns (header names are case/space-insensitive):
 *   customerEmail | customerName + email   who the draft is for (an existing account, or a guest name + e-mail)
 *   sku | productHandle | name             catalogue variant by SKU, product by handle (+ size / color), or a custom line by name
 *   size, color, qty                       qty defaults to 1
 *   unitPrice                              NGN (e.g. 125000 or "₦125,000.50"); optional for catalogue lines (catalogue price)
 *   note                                   draft note
 *   groupKey                               rows with the same key become one draft (same customer); empty = one draft per row
 * Every row is validated first; if any row fails nothing is created. Drafts are created in one transaction.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/core/db/prisma";
import { ApiError } from "@/core/http/errors";
import { formatters, nextSequence } from "@/core/utils/sequence";
import { toCsv } from "@/core/utils/csv";
import { fullName } from "@/modules/identity/auth/customer.mapper";
import { productInclude } from "@/modules/catalog/products/product.mapper";
import { pickVariant } from "@/modules/commerce/carts/carts.service";
import type { DraftLine } from "../draft-orders/draft-orders.mapper";
import { parseCsv } from "./draft-import.csv";

const MAX_ROWS = 1000;
const COLUMNS = ["customerEmail", "customerName", "email", "sku", "productHandle", "name", "size", "color", "qty", "unitPrice", "note", "groupKey"] as const;
type Column = (typeof COLUMNS)[number];
const ALIASES: Record<string, Column> = {
  customeremail: "customerEmail", customername: "customerName", email: "email", guestemail: "email", sku: "sku",
  producthandle: "productHandle", handle: "productHandle", name: "name", productname: "name", itemname: "name",
  size: "size", color: "color", colour: "color", qty: "qty", quantity: "qty", unitprice: "unitPrice", price: "unitPrice",
  note: "note", notes: "note", groupkey: "groupKey", group: "groupKey",
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ImportError = { row: number; column?: string; message: string };
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type Who = { customerId: string | null; customerName: string; email: string | null; key: string };
type Parsed = { row: number; who: Who; line: DraftLine; note: string | null; group: string };

/** "₦125,000.50" / "125000" / "125 000" → kobo */
function nairaToKobo(s: string): number | null {
  const clean = s.replace(/[₦\s,]|NGN/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export const draftImportService = {
  COLUMNS,

  async template() {
    const v = await prisma.productVariant.findFirst({
      where: { active: true, size: { not: null }, product: { status: "active", priceOnRequest: false, deletedAt: null } },
      include: { product: { select: { handle: true } } },
      orderBy: { sku: "asc" },
    });
    const sku = v?.sku ?? "SKU-123";
    const handle = v?.product.handle ?? "product-handle";
    const rows = [
      { customerEmail: "existing.customer@example.com", customerName: "", email: "", sku, productHandle: "", name: "", size: "", color: "", qty: "1", unitPrice: "", note: "Catalogue price", groupKey: "" },
      { customerEmail: "", customerName: "Ada Obi", email: "ada@example.com", sku: "", productHandle: handle, name: "", size: v?.size ?? "M", color: v?.color ?? "", qty: "2", unitPrice: "", note: "Two lines, one draft", groupKey: "ada-1" },
      { customerEmail: "", customerName: "Ada Obi", email: "ada@example.com", sku: "", productHandle: "", name: "Gift wrapping", size: "", color: "", qty: "1", unitPrice: "5000", note: "", groupKey: "ada-1" },
    ];
    return toCsv(rows, [...COLUMNS]);
  },

  /** parse + validate everything; returns the drafts to create or the row errors */
  async validate(text: string) {
    const errors: ImportError[] = [];
    const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
    if (!table.length) return { errors: [{ row: 1, message: "The file is empty." }], groups: [] };
    const header = table[0].map((h) => ALIASES[h.trim().toLowerCase().replace(/[^a-z]/g, "")] ?? null);
    const unknown = table[0].filter((_, i) => !header[i]).map((h) => h.trim()).filter(Boolean);
    if (unknown.length) errors.push({ row: 1, message: `Unknown column(s): ${unknown.join(", ")}. Use: ${COLUMNS.join(", ")}.` });
    if (!header.includes("sku") && !header.includes("productHandle") && !header.includes("name"))
      return { errors: [...errors, { row: 1, message: "Add a sku, productHandle or name column." }], groups: [] };
    if (!header.includes("customerEmail") && !(header.includes("customerName") && header.includes("email")))
      return { errors: [...errors, { row: 1, message: "Add a customerEmail column, or customerName + email." }], groups: [] };
    const body = table.slice(1);
    if (!body.length) return { errors: [...errors, { row: 2, message: "No rows to import." }], groups: [] };
    if (body.length > MAX_ROWS) return { errors: [...errors, { row: MAX_ROWS + 2, message: `Import up to ${MAX_ROWS} rows at a time.` }], groups: [] };

    // lookups in bulk
    const records = body.map((cells, i) => {
      const r = {} as Record<Column, string>;
      for (const c of COLUMNS) r[c] = "";
      header.forEach((col, j) => {
        if (col) r[col] = (cells[j] ?? "").trim();
      });
      // physical line in the file is unknown with multi-line cells; use the record number (header = row 1)
      return { row: i + 2, r };
    });
    const emails = [...new Set(records.map((x) => x.r.customerEmail.toLowerCase()).filter(Boolean))];
    const customers = emails.length ? await prisma.customer.findMany({ where: { email: { in: emails }, deletedAt: null }, select: { id: true, firstName: true, lastName: true, email: true } }) : [];
    const skus = [...new Set(records.map((x) => x.r.sku).filter(Boolean))];
    const variants = skus.length ? await prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true, productId: true } }) : [];
    const handles = [...new Set(records.map((x) => x.r.productHandle).filter(Boolean))];
    const productIds = [...new Set(variants.map((v) => v.productId))];
    const products = handles.length || productIds.length
      ? await prisma.product.findMany({ where: { OR: [{ handle: { in: handles } }, { id: { in: productIds } }], deletedAt: null }, include: productInclude })
      : [];

    const parsed: Parsed[] = [];
    for (const { row, r } of records) {
      const before = errors.length;
      const err = (message: string, column?: Column) => errors.push({ row, column, message });

      // who
      let who: Who | null = null;
      if (r.customerEmail) {
        const c = customers.find((x) => x.email.toLowerCase() === r.customerEmail.toLowerCase());
        if (!c) err(`No customer account with e-mail ${r.customerEmail}. For a guest, use customerName + email instead.`, "customerEmail");
        else who = { customerId: c.id, customerName: r.customerName || fullName(c), email: c.email, key: `c:${c.id}` };
      } else if (r.customerName && r.email) {
        if (!EMAIL.test(r.email)) err(`"${r.email}" is not a valid e-mail.`, "email");
        else if (r.customerName.length > 160) err("customerName is too long (160 characters max).", "customerName");
        else who = { customerId: null, customerName: r.customerName, email: r.email.toLowerCase(), key: `g:${r.email.toLowerCase()}:${r.customerName.toLowerCase()}` };
      } else err("Give customerEmail (existing customer), or customerName + email (guest).", "customerEmail");

      // qty + price
      const qty = r.qty === "" ? 1 : Number(r.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) err(`qty must be a whole number from 1 to 100 (got "${r.qty}").`, "qty");
      const unitPrice = r.unitPrice === "" ? null : nairaToKobo(r.unitPrice);
      if (r.unitPrice !== "" && unitPrice === null) err(`unitPrice must be an amount in NGN, e.g. 125000 or 125000.50 (got "${r.unitPrice}").`, "unitPrice");

      // item
      let line: DraftLine | null = null;
      let p: ProductRow | undefined;
      let size = r.size || null;
      let color = r.color || null;
      if (r.sku) {
        const v = variants.find((x) => x.sku === r.sku);
        p = v ? products.find((x) => x.id === v.productId) : undefined;
        if (!v || !p) err(`No product with SKU "${r.sku}".`, "sku");
        else {
          const variant = p.variants.find((x) => x.sku === r.sku);
          if (!variant) err(`SKU "${r.sku}" is no longer sold.`, "sku");
          else {
            if ((r.size && variant.size && r.size !== variant.size) || (r.color && variant.color && r.color !== variant.color))
              err(`SKU "${r.sku}" is ${[variant.color, variant.size].filter(Boolean).join(" / ")}, not ${[r.color, r.size].filter(Boolean).join(" / ")}.`, "sku");
            size = variant.size;
            color = variant.color;
          }
        }
      } else if (r.productHandle) {
        p = products.find((x) => x.handle === r.productHandle);
        if (!p) err(`No product with handle "${r.productHandle}".`, "productHandle");
        else if (p.variants.some((v) => v.color) && !color) color = p.colors[0]?.name ?? null;
      } else if (!r.name) err("Give a sku, productHandle or name (custom line).", "sku");
      else if (unitPrice === null && r.unitPrice === "") err("A custom line needs a unitPrice.", "unitPrice");

      if (p && p.status !== "active") err(`${p.name} is not active in the catalogue.`, r.sku ? "sku" : "productHandle");
      if (p && p.priceOnRequest && r.unitPrice === "") err(`${p.name} is price-on-request. Enter a unitPrice.`, "unitPrice");
      if (p && errors.length === before) {
        try {
          const v = p.variants.length ? pickVariant(p, size, color) : null;
          line = {
            productId: p.id, variantId: v?.id ?? null, sku: v?.sku ?? null, name: r.name || p.name, brand: p.brand.name,
            size: v?.size ?? size, color: v?.color ?? color, qty, unitPrice: unitPrice ?? v?.price ?? p.price,
            imageUrl: p.images.find((img) => img.color && img.color === color)?.url ?? p.images[0]?.url ?? null, custom: false,
          };
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          const sizes = [...new Set(p.variants.map((v) => v.size).filter(Boolean))].join(", ");
          const colors = [...new Set(p.variants.map((v) => v.color).filter(Boolean))].join(", ");
          err(`${p.name}: ${e.message}${sizes ? ` Sizes: ${sizes}.` : ""}${colors ? ` Colours: ${colors}.` : ""}`, "size");
        }
      } else if (!p && !r.sku && !r.productHandle && r.name && errors.length === before) {
        if (r.name.length > 200) err("name is too long (200 characters max).", "name");
        else line = { productId: null, variantId: null, sku: null, name: r.name, brand: "", size, color, qty, unitPrice: unitPrice!, imageUrl: null, custom: true };
      }
      if (r.note.length > 2000) err("note is too long (2000 characters max).", "note");
      if (errors.length === before && who && line) parsed.push({ row, who, line, note: r.note || null, group: r.groupKey || `#row${row}` });
    }

    // groups: one customer per group, up to 100 lines
    const groups = new Map<string, Parsed[]>();
    for (const p of parsed) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    for (const [key, rows] of groups) {
      const first = rows[0];
      for (const x of rows.slice(1))
        if (x.who.key !== first.who.key)
          errors.push({ row: x.row, column: "groupKey", message: `groupKey "${key}" is used for different customers (row ${first.row} is ${first.who.customerName}).` });
      if (rows.length > 100) errors.push({ row: rows[100].row, column: "groupKey", message: `groupKey "${key}" has more than 100 lines.` });
    }
    errors.sort((a, b) => a.row - b.row);
    return { errors, groups: [...groups.values()] };
  },

  async import(text: string, actor: string, dryRun = false) {
    const { errors, groups } = await this.validate(text);
    const preview = groups.map((rows) => {
      const subtotal = rows.reduce((n, x) => n + x.line.unitPrice * x.line.qty, 0);
      return {
        rows: rows.map((x) => x.row), customerName: rows[0].who.customerName, email: rows[0].who.email, customerId: rows[0].who.customerId,
        lines: rows.length, subtotal, total: subtotal,
      };
    });
    if (errors.length || dryRun) return { created: [], errors, valid: !errors.length, drafts: preview.length, preview: dryRun ? preview : undefined };

    const created = await prisma.$transaction(async (tx) => {
      const out: { id: string; number: string; customerName: string; email: string | null; lines: number; total: number; rows: number[] }[] = [];
      for (const rows of groups) {
        const who = rows[0].who;
        const lines = rows.map((x) => x.line);
        const notes = [...new Set(rows.map((x) => x.note).filter(Boolean))] as string[];
        const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
        const d = await tx.draftOrder.create({
          data: {
            number: formatters.draft(await nextSequence(tx, "draft", 3500)),
            customerId: who.customerId, customerName: who.customerName, email: who.email,
            items: lines as unknown as Prisma.InputJsonValue,
            subtotal, discount: 0, shipping: 0, total: subtotal,
            note: notes.length ? notes.join("; ").slice(0, 2000) : null,
            createdBy: actor,
          },
        });
        out.push({ id: d.id, number: d.number, customerName: d.customerName, email: d.email, lines: lines.length, total: d.total, rows: rows.map((x) => x.row) });
      }
      return out;
    }, { timeout: 60_000 });
    return { created, errors: [] as ImportError[], valid: true, drafts: created.length };
  },
};
