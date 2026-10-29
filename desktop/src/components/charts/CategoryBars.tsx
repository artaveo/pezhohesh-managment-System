import { fa } from "../../lib/solar";

export const LABELS: Record<string, string> = {
  monthly: "عضویت ماهانه", daily: "عضویت روزانه", internet: "انترنت ماهانه",
  hotspot: "کارت هاتسپات", books: "امانت کتاب", misc: "عواید متفرقه", services: "طلبات (عواید خدمات)",
};

// One measure across categories: single-hue horizontal bars, value labels in text ink.
export function CategoryBars({ data, empty = "هنوز درآمدی در این دوره ثبت نشده." }: { data: { category: string; amount: number }[]; empty?: string }) {
  const max = Math.max(1, ...data.map((d) => d.amount));
  const total = data.reduce((s, d) => s + d.amount, 0);
  if (!data.length) return <p className="muted">{empty}</p>;
  return (
    <ul className="bars">
      {data.map((d) => (
        <li key={d.category} title={`${LABELS[d.category] ?? d.category}: ${fa(d.amount)} ؋`}>
          <span className="bar-label">{LABELS[d.category] ?? d.category}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(d.amount / max) * 100}%` }} /></span>
          <span className="bar-value">{fa(d.amount)} <small>{fa((d.amount / total) * 100)}%</small></span>
        </li>
      ))}
    </ul>
  );
}
