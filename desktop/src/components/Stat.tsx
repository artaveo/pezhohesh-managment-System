import type { ReactNode } from "react";
import { fa } from "../lib/solar";
import { Icon } from "./Icon";

/** Change vs an earlier figure; arrow + sign carry the direction, color only reinforces it. */
export function Delta({ value, prev, upIsGood = true }: { value: number; prev: number; upIsGood?: boolean }) {
  if (prev === 0 && value === 0) return <span className="delta flat">بدون تغییر</span>;
  if (prev === 0) return <span className={`delta ${value > 0 === upIsGood ? "good" : "bad"}`}><Icon name={value > 0 ? "up" : "down"} size={14} />جدید</span>;
  const pct = ((value - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="delta flat">بدون تغییر</span>;
  const up = pct > 0;
  const good = up === upIsGood;
  return (
    <span className={`delta ${good ? "good" : "bad"}`} aria-label={`${up ? "افزایش" : "کاهش"} ${fa(Math.abs(pct))} درصد`}>
      <Icon name={up ? "up" : "down"} size={14} />{fa(Math.abs(pct))}%
    </span>
  );
}

/** A number in a table cell with its change underneath. */
export function Figure({ value, prev, upIsGood = true, show = value }: { value: number; prev: number | null; upIsGood?: boolean; show?: number }) {
  return (
    <span className="figure">
      <span>{fa(show)}</span>
      {prev !== null && <Delta value={value} prev={prev} upIsGood={upIsGood} />}
    </span>
  );
}

export type Comparison = { prev: number; vs: string };

/** One figure and how it compares with one or more earlier periods. */
export function Kpi({ icon, label, value, unit, compare = [], hero, upIsGood = true, note }: {
  icon: string; label: string; value: number; unit: string; compare?: Comparison[]; hero?: boolean; upIsGood?: boolean; note?: ReactNode;
}) {
  return (
    <div className={`glass kpi${hero ? " hero" : ""}`}>
      <div className="kpi-top">
        <span className="kpi-icon"><Icon name={icon} /></span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value">{fa(value)} <small>{unit}</small></div>
      {compare.map((c) => (
        <div className="kpi-foot" key={c.vs}><Delta value={value} prev={c.prev} upIsGood={upIsGood} /> <span className="muted small">{c.vs}</span></div>
      ))}
      {note && <div className="kpi-foot muted small">{note}</div>}
    </div>
  );
}

export function Failed({ retry }: { retry: () => void }) {
  return (
    <div className="glass loading">
      <p className="muted">گزارش بارگذاری نشد؛ هستهٔ سیستم جواب نداد.</p>
      <button className="btn" onClick={retry}>دوباره امتحان کن</button>
    </div>
  );
}

export const Loading = () => <div className="glass loading">در حال بارگذاری…</div>;
