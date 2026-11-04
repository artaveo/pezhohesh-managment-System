import { useMemo, useState } from "react";
import { MONTHS, addDays, formatDay, fromSolar, iso, lastAheadMonth, monthStart, monthsOfYear, nextMonth, nextYear, parseIso, prevMonth, prevYear, toSolar, yearStart } from "../lib/solar";
import { SolarDate } from "./SolarDate";

export type Span = "today" | "month" | "year" | "all" | "range";
export type PeriodState = { span: Span; month: string; year: string; from: string; to: string };
/** Inclusive ISO days; left out = no limit. */
export type Range = { from?: string; to?: string };

const SPAN_LABEL: Record<Span, string> = { today: "امروز", month: "ماه", year: "سال", all: "همه", range: "از تاریخ تا تاریخ" };
const solarMonth = (ms: Date) => { const s = toSolar(ms); return `${MONTHS[s.m - 1]} ${s.y}`; };

export function initialPeriod(span: Span = "month"): PeriodState {
  const today = iso(new Date());
  return { span, month: iso(monthStart()), year: iso(yearStart()), from: iso(monthStart()), to: today };
}

/** The days a period covers, and how its title reads ("عقرب 1405", "امروز"…). */
export function rangeOf(p: PeriodState): Range & { label: string } {
  const today = iso(new Date());
  switch (p.span) {
    case "today":
      return { from: today, to: today, label: "امروز" };
    case "month": {
      const ms = parseIso(p.month);
      return { from: p.month, to: iso(addDays(nextMonth(ms), -1)), label: solarMonth(ms) };
    }
    case "year": {
      const ys = parseIso(p.year);
      return { from: p.year, to: iso(addDays(nextYear(ys), -1)), label: `سال ${toSolar(ys).y}` };
    }
    case "range":
      return { from: p.from || undefined, to: p.to || undefined, label: `از ${p.from ? formatDay(p.from) : "…"} تا ${p.to ? formatDay(p.to) : "…"}` };
    default:
      return { label: "همه" };
  }
}

/** Period state plus its range, for a page's filter. */
export function usePeriod(span: Span = "month") {
  const [value, setValue] = useState(() => initialPeriod(span));
  const range = useMemo(() => rangeOf(value), [value]);
  return { value, setValue, range };
}

/**
 * The one period filter of every list page: quick choices (today, a month with previous and
 * next, a year, everything) and any range typed as two Solar dates.
 */
export function PeriodPicker({ value, onChange, spans = ["today", "month", "year", "all", "range"] }: {
  value: PeriodState;
  onChange: (p: PeriodState) => void;
  spans?: Span[];
}) {
  const set = (patch: Partial<PeriodState>) => onChange({ ...value, ...patch });
  // Months paid in advance have their bills in their own month: the steps go that far ahead.
  const lastMonth = iso(lastAheadMonth());
  const lastYear = iso(nextYear(yearStart()));
  const ms = parseIso(value.month);
  const ys = parseIso(value.year);
  const months = monthsOfYear(yearStart(ms)).slice(0, 12);
  // Years to pick from: the last few, up to the latest one the steps reach.
  const latestY = toSolar(parseIso(value.span === "year" ? lastYear : lastMonth)).y;
  const years = Array.from({ length: 8 }, (_, i) => latestY - 7 + i);
  const yearOf = (y: number) => iso(fromSolar({ y, m: 1, d: 1 }) ?? ys);
  // Another year keeps the month (Aqrab of 1404 to Aqrab of 1405), but never past the last one.
  const monthIn = (y: number) => {
    const m = iso(fromSolar({ y, m: toSolar(ms).m, d: 1 }) ?? ms);
    return m > lastMonth ? lastMonth : m;
  };
  const yearSelect = (current: number, pick: (y: number) => void) => (
    <select aria-label="سال" className="year-select" value={current} onChange={(e) => pick(Number(e.target.value))}>
      {(years.includes(current) ? years : [current, ...years]).map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
  return (
    <div className="period-picker">
      <div className="segmented" role="tablist" aria-label="دوره">
        {spans.map((s) => (
          <button key={s} role="tab" aria-selected={value.span === s} className={value.span === s ? "on" : ""} onClick={() => set({ span: s })}>
            {SPAN_LABEL[s]}
          </button>
        ))}
      </div>
      {value.span === "month" && (
        <div className="period-step">
          <button className="btn ghost small" onClick={() => set({ month: iso(prevMonth(ms)) })}>‹ ماه قبل</button>
          {yearSelect(toSolar(ms).y, (y) => set({ month: monthIn(y) }))}
          <select aria-label="ماه" value={value.month} onChange={(e) => set({ month: e.target.value })}>
            {months.map((m) => <option key={iso(m)} value={iso(m)} disabled={iso(m) > lastMonth}>{MONTHS[toSolar(m).m - 1]}</option>)}
          </select>
          <button className="btn ghost small" disabled={value.month >= lastMonth} onClick={() => set({ month: iso(nextMonth(ms)) })}>ماه بعد ›</button>
        </div>
      )}
      {value.span === "year" && (
        <div className="period-step">
          <button className="btn ghost small" onClick={() => set({ year: iso(prevYear(ys)) })}>‹ سال قبل</button>
          {yearSelect(toSolar(ys).y, (y) => set({ year: yearOf(y) }))}
          <button className="btn ghost small" disabled={value.year >= lastYear} onClick={() => set({ year: iso(nextYear(ys)) })}>سال بعد ›</button>
        </div>
      )}
      {value.span === "range" && (
        <div className="range-row">
          <SolarDate label="از تاریخ" value={value.from} onChange={(from) => set({ from })} />
          <SolarDate label="تا تاریخ" value={value.to} onChange={(to) => set({ to })} />
        </div>
      )}
    </div>
  );
}
