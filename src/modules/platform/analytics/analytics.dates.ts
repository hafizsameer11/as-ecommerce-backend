/**
 * Business days are Lagos days (Africa/Lagos = UTC+1, no daylight saving).
 * A "day key" is "YYYY-MM-DD" in Lagos time; rollup tables store it in a DATE column.
 */
const OFFSET_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

/** Lagos day of an instant */
export const dayKey = (d: Date = new Date()) => new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);
/** UTC instant where the Lagos day starts */
export const dayStart = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - OFFSET_MS);
/** [start, end) of a Lagos day as UTC instants */
export const dayBounds = (key: string) => {
  const start = dayStart(key);
  return { start, end: new Date(start.getTime() + DAY_MS) };
};
/** value for a @db.Date column */
export const dbDate = (key: string) => new Date(`${key}T00:00:00Z`);
/** DATE column value → day key */
export const keyOf = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** inclusive list of day keys */
export function keysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let k = from; k <= to && out.length < 1000; k = addDays(k, 1)) out.push(k);
  return out;
}

export const RANGE_DAYS = { "7d": 7, "14d": 14, "30d": 30, "90d": 90, "12m": 365 } as const;
export type Range = keyof typeof RANGE_DAYS;

/** a range ending today (inclusive) + the same-length period right before it */
export function periodOf(range: Range, now = new Date()) {
  const days = RANGE_DAYS[range];
  const to = dayKey(now);
  const from = addDays(to, -(days - 1));
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    days, from, to, prevFrom, prevTo,
    keys: keysBetween(from, to),
    start: dayStart(from), end: dayBounds(to).end,
    prevStart: dayStart(prevFrom), prevEnd: dayStart(from),
  };
}
export type Period = ReturnType<typeof periodOf>;

/** "2026-03" month key (Lagos) and helpers for cohorts */
export const monthKey = (d: Date) => dayKey(d).slice(0, 7);
export const addMonths = (mk: string, n: number) => {
  const [y, m] = mk.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
export const monthsBetween = (a: string, b: string) => {
  const [ya, ma] = a.split("-").map(Number);
  const [yb, mb] = b.split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (mk: string) => `${MONTHS[Number(mk.slice(5, 7)) - 1]} ${mk.slice(2, 4)}`;

/** change vs the previous period as a fraction (0.124 = +12.4 %); null when there is nothing to compare */
export const delta = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 10_000) / 10_000 : null);
export const ratio = (a: number, b: number, digits = 4) => (b ? Math.round((a / b) * 10 ** digits) / 10 ** digits : 0);
