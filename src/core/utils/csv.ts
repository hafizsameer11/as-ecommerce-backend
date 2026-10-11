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
