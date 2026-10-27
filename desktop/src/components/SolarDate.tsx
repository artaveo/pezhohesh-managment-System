import { useEffect, useState } from "react";
import { MONTHS, fromSolar, iso, toSolar, weekdayName } from "../lib/solar";

/**
 * A Solar date typed as day / month / year (Afghan month names), kept as an ISO date.
 * Shows the weekday under it so a wrong day is easy to spot.
 */
export function SolarDate({ value, onChange, label }: { value: string; onChange: (iso: string) => void; label: string }) {
  const [day, setDay] = useState(() => toSolar(value));
  const [typed, setTyped] = useState({ d: String(day.d), y: String(day.y) });

  // Follow a value changed from outside (another plan, a reset); "" is our own invalid day.
  useEffect(() => {
    if (!value) return;
    const s = toSolar(value);
    setDay(s);
    setTyped({ d: String(s.d), y: String(s.y) });
  }, [value]);

  function set(next: { d?: string; m?: number; y?: string }) {
    const t = { d: next.d ?? typed.d, y: next.y ?? typed.y };
    setTyped(t);
    const s = { y: Number(t.y), m: next.m ?? day.m, d: Number(t.d) };
    setDay(s);
    const g = fromSolar(s);
    // A day that does not exist is reported as "" so the form cannot be saved with an old date.
    onChange(g ? iso(g) : "");
  }

  const valid = fromSolar(day) !== null;
  return (
    <div className="field wide">
      <span>{label}</span>
      <div className="solar-date" dir="rtl">
        <input aria-label="روز" inputMode="numeric" value={typed.d} onChange={(e) => set({ d: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
        <select aria-label="ماه" value={day.m} onChange={(e) => set({ m: Number(e.target.value) })}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input aria-label="سال" inputMode="numeric" value={typed.y} onChange={(e) => set({ y: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
      </div>
      <small className={valid ? "muted" : "form-error inline"}>{valid && value ? weekdayName(value) : "این تاریخ وجود ندارد"}</small>
    </div>
  );
}
