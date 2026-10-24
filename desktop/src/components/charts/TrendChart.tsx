import { useMemo, useState } from "react";
import { fa, formatShort } from "../../lib/solar";

type Point = { day: string; income: number; expenses: number };

// Income (accent, solid area) vs expenses (dashed neutral line), one axis in Afghani.
export function TrendChart({ data }: { data: Point[] }) {
  const W = 720, H = 240, L = 56, R = 16, T = 16, B = 28;
  const [hover, setHover] = useState<number | null>(null);

  const { x, y, ticks, incomePath, areaPath, expensePath } = useMemo(() => {
    const max = Math.max(1000, ...data.flatMap((d) => [d.income, d.expenses]));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, data.length - 1);
    const y = (v: number) => T + (1 - v / top) * (H - T - B);
    const line = (k: "income" | "expenses") => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join("");
    const incomePath = line("income");
    const areaPath = `${incomePath}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    return { x, y, ticks, incomePath, areaPath, expensePath: line("expenses") };
  }, [data]);

  if (!data.length) return null;
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="درآمد و مصارف ۳۰ روز اخیر"
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - L) / (W - L - R)) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, i)));
        }}>
        <defs>
          <linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 8} y={y(t) + 4} className="axis" textAnchor="end">{compact(t)}</text>
          </g>
        ))}
        {data.map((d, i) => ((i % 7 === 0 && data.length - 1 - i >= 4) || i === data.length - 1) && (
          <text key={d.day} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{formatShort(d.day)}</text>
        ))}
        <path d={areaPath} fill="url(#incomeFill)" />
        <path d={incomePath} className="line-income" />
        <path d={expensePath} className="line-expense" />
        {h && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="crosshair" />
            <circle cx={x(hover)} cy={y(h.income)} r={5} className="dot-income" />
            <circle cx={x(hover)} cy={y(h.expenses)} r={4} className="dot-expense" />
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{formatShort(h.day)}</strong>
          <span><i className="sw sw-income" />درآمد: {fa(h.income)} ؋</span>
          <span><i className="sw sw-expense" />مصارف: {fa(h.expenses)} ؋</span>
        </div>
      )}
      <div className="legend">
        <span><i className="sw sw-income" />درآمد</span>
        <span><i className="sw sw-expense" />مصارف</span>
      </div>
    </div>
  );
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
const compact = (v: number) => (v >= 1000 ? `${fa(v / 1000)} هزار` : fa(v));
