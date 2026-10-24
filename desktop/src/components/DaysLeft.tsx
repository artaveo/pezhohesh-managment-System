import { fa } from "../lib/solar";

/** Days until an end date: counts on past zero (-1, -2 ...) once it has passed. */
export function DaysLeft({ days, soon = 5 }: { days: number | null; soon?: number }) {
  if (days === null) return <span className="days none">بدون عضویت</span>;
  if (days < 0) return <span className="days late" title={`${fa(-days)} روز گذشته`}><bdi dir="ltr">{fa(days)}</bdi> روز</span>;
  if (days === 0) return <span className="days due">امروز ختم</span>;
  if (days <= soon) return <span className="days due">{fa(days)} روز مانده</span>;
  return <span className="days ok">{fa(days)} روز مانده</span>;
}
