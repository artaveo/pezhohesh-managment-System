// Solar Hijri (Afghan month names) helpers built on the browser's Persian calendar.

const parts = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", { year: "numeric", month: "numeric", day: "numeric" });

function solar(d: Date): { y: number; m: number; d: number } {
  const p = Object.fromEntries(parts.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** First Gregorian day of the Solar month (or year) that contains `d`. */
function startOf(d: Date, unit: "month" | "year"): Date {
  let x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  for (let i = 0; i < 400; i++) {
    const s = solar(x);
    if (s.d === 1 && (unit === "month" || s.m === 1)) return x;
    x = addDays(x, -1);
  }
  return x;
}

/** Solar month and year boundaries, each the first Gregorian day of that month or year. */
export const monthStart = (d = new Date()) => startOf(d, "month");
export const nextMonth = (ms: Date) => startOf(addDays(ms, 32), "month");
export const prevMonth = (ms: Date) => startOf(addDays(ms, -1), "month");
// A Solar month is 29 to 31 days and a year 365 or 366, so 360 days back is always inside the same month a year earlier.
export const sameMonthLastYear = (ms: Date) => startOf(addDays(ms, -360), "month");
export const yearStart = (d = new Date()) => startOf(d, "year");
export const nextYear = (ys: Date) => startOf(addDays(ys, 370), "year");
export const prevYear = (ys: Date) => startOf(addDays(ys, -1), "year");
/** The 12 month starts of the year beginning at `ys`, plus the next year's start. */
export function monthsOfYear(ys: Date): Date[] {
  const out = [ys];
  for (let i = 0; i < 12; i++) out.push(nextMonth(out[i]));
  return out;
}
export const parseIso = (s: string) => new Date(s + "T00:00:00");
export const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 864e5);

export type Period = "day" | "month" | "year";

/** Current window [from, to) and the previous one starting at prev_from, as ISO dates. */
export function windowFor(period: Period, today = new Date()) {
  if (period === "day") {
    return { from: iso(today), to: iso(addDays(today, 1)), prev_from: iso(addDays(today, -1)) };
  }
  const from = startOf(today, period);
  const prev = startOf(addDays(from, -1), period);
  const next = startOf(addDays(from, period === "month" ? 32 : 370), period);
  return { from: iso(from), to: iso(next), prev_from: iso(prev) };
}

const longDate = new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { day: "numeric", month: "long" });
export const formatLong = (d: Date) => {
  const p = Object.fromEntries(longDate.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday}، ${p.day} ${p.month} ${p.year}`;
};
export const formatShort = (d: Date | string) => shortDate.format(typeof d === "string" ? new Date(d + "T00:00:00") : d);
export const monthName = (d = new Date()) => new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { month: "long" }).format(d);
export const yearNumber = (d = new Date()) => new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { year: "numeric" }).format(d);

const num = new Intl.NumberFormat("en-US");
// Negative numbers are isolated left-to-right so the minus stays in front inside Persian text.
export const fa = (n: number) => {
  const s = num.format(Math.round(n));
  return s.startsWith("-") ? `\u2066${s}\u2069` : s;
};
