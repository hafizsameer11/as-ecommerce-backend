import { ZodError } from "zod";
import { ApiError } from "@/core/http/errors";
import { parseCsv, toCsv } from "@/core/utils/csv";
import { createDraftBody, type CreateDraftBody, type DraftItemInput } from "./draft-orders.schemas";
import { draftOrdersService } from "./draft-orders.service";

/** One row per line; rows with the same `draft_key` become one draft. Amounts are NGN (not kobo). */
export const DRAFT_IMPORT_COLUMNS = [
  "draft_key",
  "customerId",
  "customerName",
  "email",
  "discount",
  "shipping",
  "note",
  "productId",
  "name",
  "brand",
  "size",
  "color",
  "qty",
  "unitPrice",
  "imageUrl",
] as const;

const DRAFT_IMPORT_HEADERS = [
  "draft_key",
  "customerId",
  "customerName",
  "email",
  "discount (NGN)",
  "shipping (NGN)",
  "note",
  "productId",
  "name",
  "brand",
  "size",
  "color",
  "qty",
  "unitPrice (NGN)",
  "imageUrl",
];

const HEADER_TO_FIELD: Record<string, (typeof DRAFT_IMPORT_COLUMNS)[number]> = {
  draft_key: "draft_key",
  customerid: "customerId",
  customername: "customerName",
  email: "email",
  discount: "discount",
  "discount (ngn)": "discount",
  shipping: "shipping",
  "shipping (ngn)": "shipping",
  note: "note",
  productid: "productId",
  name: "name",
  brand: "brand",
  size: "size",
  color: "color",
  qty: "qty",
  unitprice: "unitPrice",
  "unitprice (ngn)": "unitPrice",
  imageurl: "imageUrl",
};

function canonicalRow(raw: Record<string, string>): Record<(typeof DRAFT_IMPORT_COLUMNS)[number], string> {
  const out = Object.fromEntries(DRAFT_IMPORT_COLUMNS.map((c) => [c, ""])) as Record<(typeof DRAFT_IMPORT_COLUMNS)[number], string>;
  for (const [h, v] of Object.entries(raw)) {
    const field = HEADER_TO_FIELD[h.trim().toLowerCase()];
    if (field) out[field] = v.trim();
  }
  return out;
}

function nairaToKobo(raw: string): number | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * 100);
}

function intOr(raw: string, fallback: number): number {
  const t = raw.trim();
  if (!t) return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : NaN;
}

function optionalStr(raw: string): string | undefined {
  const t = raw.trim();
  return t || undefined;
}

function zodMessage(err: ZodError): string {
  const f = err.issues[0];
  if (!f) return "Validation failed";
  const where = f.path.length ? `${f.path.join(".")}: ` : "";
  return `${where}${f.message}`;
}

function errMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof ZodError) return zodMessage(err);
  if (err instanceof Error) return err.message;
  return "Import failed";
}

type RowDraft = { row: number; draftKey: string; flat: Record<(typeof DRAFT_IMPORT_COLUMNS)[number], string> };

function buildItem(flat: RowDraft["flat"]): { item?: DraftItemInput; error?: string } {
  const qty = intOr(flat.qty, 1);
  if (Number.isNaN(qty) || qty < 1) return { error: "qty must be a whole number ≥ 1" };
  const unitPrice = nairaToKobo(flat.unitPrice);
  if (flat.unitPrice.trim() && (unitPrice === undefined || Number.isNaN(unitPrice))) return { error: "unitPrice must be a number (NGN)" };
  const item: DraftItemInput = {
    productId: optionalStr(flat.productId),
    name: optionalStr(flat.name),
    brand: optionalStr(flat.brand),
    size: optionalStr(flat.size) ?? null,
    color: optionalStr(flat.color) ?? null,
    qty,
    unitPrice,
    imageUrl: optionalStr(flat.imageUrl) ?? null,
  };
  return { item };
}

function groupDrafts(rows: RowDraft[]): { firstRow: number; body: CreateDraftBody; rowErrors: { row: number; message: string }[] }[] {
  const map = new Map<string, { firstRow: number; flats: RowDraft[] }>();
  for (const r of rows) {
    const draftKey = r.flat.draft_key || `row-${r.row}`;
    let g = map.get(draftKey);
    if (!g) {
      g = { firstRow: r.row, flats: [] };
      map.set(draftKey, g);
    }
    g.flats.push(r);
  }
  return [...map.values()].map((g) => {
    const rowErrors: { row: number; message: string }[] = [];
    const items: DraftItemInput[] = [];
    let customerId: string | undefined;
    let customerName: string | undefined;
    let email: string | undefined;
    let note: string | undefined;
    let discount = 0;
    let shipping = 0;
    for (const r of g.flats) {
      if (r.flat.customerId) customerId = r.flat.customerId;
      if (r.flat.customerName) customerName = r.flat.customerName;
      if (r.flat.email) email = r.flat.email;
      if (r.flat.note) note = r.flat.note;
      const d = nairaToKobo(r.flat.discount);
      if (r.flat.discount.trim() && Number.isNaN(d)) rowErrors.push({ row: r.row, message: "discount must be a number (NGN)" });
      else if (d !== undefined && !Number.isNaN(d)) discount = d;
      const sh = nairaToKobo(r.flat.shipping);
      if (r.flat.shipping.trim() && Number.isNaN(sh)) rowErrors.push({ row: r.row, message: "shipping must be a number (NGN)" });
      else if (sh !== undefined && !Number.isNaN(sh)) shipping = sh;
      const built = buildItem(r.flat);
      if (built.error) rowErrors.push({ row: r.row, message: built.error });
      else if (built.item) items.push(built.item);
    }
    return {
      firstRow: g.firstRow,
      rowErrors,
      body: { customerId, customerName, email, items, discount, shipping, note },
    };
  });
}

export type DraftImportResult = {
  created: number;
  errors: { row: number; message: string }[];
  drafts?: { id: string; number: string }[];
};

export function draftImportTemplateCsv() {
  return toCsv(
    [
      {
        draft_key: "1",
        customerId: "",
        customerName: "Adaeze O.",
        email: "ada@example.com",
        discount: 0,
        shipping: 4000,
        note: "VIP price hold",
        productId: "",
        name: "Custom quote line",
        brand: "",
        size: "",
        color: "",
        qty: 1,
        unitPrice: 189000,
        imageUrl: "",
      },
      {
        draft_key: "1",
        customerId: "",
        customerName: "",
        email: "",
        discount: "",
        shipping: "",
        note: "",
        productId: "",
        name: "Second line on same draft",
        brand: "",
        size: "",
        color: "",
        qty: 2,
        unitPrice: 25000,
        imageUrl: "",
      },
    ],
    [...DRAFT_IMPORT_COLUMNS],
    DRAFT_IMPORT_HEADERS,
  );
}

export async function importDraftOrdersCsv(text: string, actor: string): Promise<DraftImportResult> {
  const parsed = parseCsv(text);
  if (!parsed.headers.length) throw ApiError.badRequest("VALIDATION_FAILED", "The file is empty or has no header row.");
  const rows: RowDraft[] = parsed.rows.map((r, idx) => ({ row: idx + 2, draftKey: "", flat: canonicalRow(r) }));
  if (!rows.length) throw ApiError.badRequest("VALIDATION_FAILED", "No data rows found.");

  const errors: DraftImportResult["errors"] = [];
  const drafts: { id: string; number: string }[] = [];
  let created = 0;

  for (const g of groupDrafts(rows)) {
    if (g.rowErrors.length) {
      errors.push(...g.rowErrors);
      continue;
    }
    if (!g.body.items.length) {
      errors.push({ row: g.firstRow, message: "Each draft needs at least one line." });
      continue;
    }
    if (g.body.items.length > 100) {
      errors.push({ row: g.firstRow, message: "A draft can't have more than 100 lines." });
      continue;
    }
    const parsedBody = createDraftBody.safeParse(g.body);
    if (!parsedBody.success) {
      errors.push({ row: g.firstRow, message: zodMessage(parsedBody.error) });
      continue;
    }
    try {
      const d = await draftOrdersService.create(parsedBody.data, actor);
      created++;
      drafts.push({ id: d.id, number: d.number });
    } catch (err) {
      errors.push({ row: g.firstRow, message: errMessage(err) });
    }
  }

  return { created, errors, drafts: drafts.length ? drafts : undefined };
}