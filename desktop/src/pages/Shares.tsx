import { useState } from "react";
import { addDays, fa, iso, monthName, monthsOfYear, nextYear, parseIso, yearNumber, yearStart } from "../lib/solar";
import { loadRanges, total, type Range, type Sum } from "../lib/reports";
import { useLoad } from "../lib/useLoad";
import { MANAGER_SALARY, PARTNERS, shares } from "../lib/shares";
import { Failed, Loading } from "../components/Stat";

/**
 * Each partner's share of the profit, month by month like the Excel statement, and the
 * year-end settlement: share minus what they took is what they are still owed.
 */
export function Shares() {
  const [ys, setYs] = useState(() => yearStart(new Date()));
  const { data, failed, retry } = useLoad(async (signal) => {
    const tomorrow = addDays(new Date(), 1);
    const months = monthsOfYear(ys);
    const ranges: Range[] = [];
    for (let i = 0; i < 12 && months[i] < tomorrow; i++) {
      ranges.push({ from: iso(months[i]), to: iso(months[i + 1] < tomorrow ? months[i + 1] : tomorrow) });
    }
    const a = await loadRanges(ranges.length ? ranges : [{ from: iso(ys), to: iso(addDays(ys, 1)) }], true, signal);
    return { months, byMonth: ranges.map(a.sum), year: total(a.res.periods), first: a.res.first_day };
  }, [iso(ys)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const now = yearStart(new Date());
  const years: Date[] = [];
  for (let y = data.first ? yearStart(parseIso(data.first)) : now; y <= now; y = nextYear(y)) years.push(y);
  if (!years.some((y) => iso(y) === iso(ys))) years.push(ys);
  const y = yearNumber(ys);
  const done = iso(nextYear(ys)) <= iso(new Date());
  const year = shares(data.year);
  const cash = year.reduce((t, s) => t + s.left, 0);

  const cell = (i: number, v: (s: Sum) => number) => (i < data.byMonth.length ? fa(v(data.byMonth[i])) : "—");
  const row = (label: string, v: (s: Sum) => number, cls = "") => (
    <tr key={label} className={cls}>
      <th scope="row">{label}</th>
      {data.months.slice(0, 12).map((_, i) => <td key={i}>{cell(i, v)}</td>)}
      <td className="remarks">{fa(v(data.year))}</td>
    </tr>
  );
  const of = (name: string, k: "share" | "taken" | "left") => (s: Sum) => shares(s).find((p) => p.name === name)![k];

  return (
    <div className="page">
      <div className="list-tools">
        <div className="segmented" role="tablist" aria-label="سال">
          {years.map((d) => (
            <button key={iso(d)} role="tab" aria-selected={iso(d) === iso(ys)} className={iso(d) === iso(ys) ? "on" : ""} onClick={() => setYs(d)}>
              {yearNumber(d)}
            </button>
          ))}
        </div>
      </div>
      <p className="muted">
        مثل صورت حساب اکسل: سهم ناصری = (بیلانس + اجوره مدیر اداری) ÷ 3؛ سهم رحیمی = دو برابر آن منهای اجوره مدیر اداری.
        «مانده» یعنی سهم منهای برداشت: مثبت طلب شریک است و منفی یعنی بیشتر از سهمش برداشته.
      </p>

      <h2>{done ? `تسویهٔ سال ${y}` : `تسویه تا امروز (سال ${y} هنوز تمام نشده)`}</h2>
      <section className="kpis settle">
        {year.map((s) => (
          <div key={s.name} className="glass kpi">
            <span className="kpi-label">{s.name}</span>
            <span className="kpi-value">{fa(Math.abs(s.left))} <small>؋ {s.left >= 0 ? "طلب" : "بیشتر برداشته"}</small></span>
            <span className="muted small">سهم {fa(s.share)} · برداشت {fa(s.taken)}</span>
          </div>
        ))}
        <div className="glass kpi">
          <span className="kpi-label">موجودی (پول باقی‌مانده)</span>
          <span className="kpi-value">{fa(cash)} <small>؋</small></span>
          <span className="muted small">بیلانس {fa(data.year.income - data.year.expenses)} منهای همهٔ برداشت‌ها</span>
        </div>
      </section>

      <section className="glass statement">
        <div className="panel-head">
          <h2>سهم شرکا، ماهوار سال {y}</h2>
          <span className="muted small">ستون ملاحظات = جمع سال</span>
        </div>
        <div className="table-wrap flush">
          <table className="table sheet">
            <thead>
              <tr><th>شرح</th>{data.months.slice(0, 12).map((m) => <th key={iso(m)}>{monthName(m)}</th>)}<th className="remarks">ملاحظات</th></tr>
            </thead>
            <tbody>
              {row("مجموع درآمد", (s) => s.income)}
              {row("مجموع مصارفات", (s) => s.expenses)}
              {row("بیلانس", (s) => s.income - s.expenses, "net")}
              {row(MANAGER_SALARY, (s) => s.expenses_by_category[MANAGER_SALARY] ?? 0)}
              <tr className="section"><th scope="row" colSpan={14}>سهمیه</th></tr>
              {PARTNERS.map((p) => row(`سهمیه ${p.short}`, of(p.name, "share"), "sum"))}
              <tr className="section"><th scope="row" colSpan={14}>برداشت</th></tr>
              {PARTNERS.map((p) => row(`برداشت ${p.short}`, of(p.name, "taken")))}
              <tr className="section"><th scope="row" colSpan={14}>مانده (سهم منهای برداشت)</th></tr>
              {PARTNERS.map((p) => row(`مانده ${p.short}`, of(p.name, "left"), "sum"))}
              {row("موجودی", (s) => shares(s).reduce((t, p) => t + p.left, 0), "net")}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
