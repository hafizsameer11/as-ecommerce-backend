/** Parse RFC 4180 CSV (UTF-8). First row = headers. */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (row.length > 1 || row[0] !== "" || rows.length === 0) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      pushField();
      pushRow();
      i += s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      pushField();
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  pushField();
  if (field !== "" || row.length > 0) pushRow();
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const data = rows.slice(1).map((cells) =>
    Object.fromEntries(headers.map((h, idx) => [h, (cells[idx] ?? "").trim()])),
  );
  return { headers, rows: data };
}

/** Minimal RFC 4180 CSV writer for admin exports. */
export function toCsv<T extends Record<string, any>>(rows: T[], columns: (keyof T & string)[], headers?: string[]) {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    // block spreadsheet formula injection (=, +, -, @ at the start of a text cell)
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = (headers ?? columns).map(cell).join(",");
  return [head, ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
