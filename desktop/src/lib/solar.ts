// Solar Hijri (Afghan month names) helpers built on the browser's Persian calendar.

const parts = new Intl.DateTimeFormat("en-u-ca-persian-nu-latn", { year: "numeric", month: "numeric", day: "numeric" });

function solar(d: Date): { y: number; m: number; d: number } {
  const p = Object.fromEntries(parts.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
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

const longDate = new Intl.DateTimeFormat("fa-AF-u-ca-persian", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("fa-AF-u-ca-persian", { day: "numeric", month: "long" });
export const formatLong = (d: Date) => {
  const p = Object.fromEntries(longDate.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday}، ${p.day} ${p.month} ${p.year}`;
};
export const formatShort = (d: Date | string) => shortDate.format(typeof d === "string" ? new Date(d + "T00:00:00") : d);
export const monthName = (d = new Date()) => new Intl.DateTimeFormat("fa-AF-u-ca-persian", { month: "long" }).format(d);
export const yearNumber = (d = new Date()) => new Intl.DateTimeFormat("fa-AF-u-ca-persian", { year: "numeric" }).format(d);

const num = new Intl.NumberFormat("fa-AF");
export const fa = (n: number) => num.format(Math.round(n));
