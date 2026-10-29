import { useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { formatLong, monthName, yearNumber, type Period } from "../lib/solar";
import { TodayView, type Go } from "./dashboard/Today";
import { MonthView } from "./dashboard/Month";
import { YearView } from "./dashboard/Year";

export type { Go };

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "امروز" },
  { id: "month", label: "این ماه" },
  { id: "year", label: "امسال" },
];

/** Three separate reports: today (with the to-do lists), this Solar month, this Solar year. */
export function Dashboard({ go }: { go: Go }) {
  const [period, setPeriod] = useState<Period>("day");
  const { user } = useAuth();
  const now = new Date();
  const title = period === "day" ? "گزارش امروز" : period === "month" ? `گزارش ماه ${monthName(now)} ${yearNumber(now)}` : `گزارش سال ${yearNumber(now)}`;

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <p className="eyebrow">{greeting(now)}{user ? `، ${user.full_name.split(" ")[0]}` : ""} · {formatLong(now)}</p>
          <h1>{title}</h1>
        </div>
        <div className="dash-tools">
          <div className="segmented" role="tablist" aria-label="دورهٔ گزارش">
            {PERIODS.map((p) => (
              <button key={p.id} role="tab" aria-selected={p.id === period} className={p.id === period ? "on" : ""} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>
      {period === "day" ? <TodayView go={go} /> : period === "month" ? <MonthView /> : <YearView />}
    </div>
  );
}

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "صبح بخیر" : h < 17 ? "روز بخیر" : "شب بخیر";
}
