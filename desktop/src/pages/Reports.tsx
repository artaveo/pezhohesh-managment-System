import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  addDays, fa, formatDay, iso, monthName, monthStart, monthsOfYear, nextMonth, nextYear, prevMonth, prevYear,
  sameMonthLastYear, toSolar, yearNumber, yearStart,
} from "../lib/solar";
import { balance, loadRanges, total, type Range, type Sum } from "../lib/reports";
import { MANAGER_SALARY, PARTNERS, shares } from "../lib/shares";
import { useLoad } from "../lib/useLoad";
import { api, type SalaryPage } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Failed, Kpi, Loading } from "../components/Stat";
import { LABELS } from "../components/charts/CategoryBars";
import { Icon } from "../components/Icon";

const INCOME_ORDER = Object.keys(LABELS);
const rankIncome = (c: string) => (INCOME_ORDER.includes(c) ? INCOME_ORDER.indexOf(c) : 99);
/** A comparison with a period that has nothing recorded would only say «جدید»; leave it out. */
const vs = (prev: number, label: string) => (prev ? [{ prev, vs: label }] : undefined);
/** Nothing was recorded in this period (e.g. a month before the app and the Excel). */
const blank = (s: Sum) => !s.income && !s.expenses && !s.estimated && !Object.keys(s.withdrawals_by_person).length;

/**
 * The Excel book's statement (محاسبات) inside the app: one month, or the 12 months of a year
 * side by side, with income and expenses by line, salaries, the profit and each partner's
 * share. Prints on A4.
 */
export function Reports() {
  const user = useAuth().user!;
  const canShares = user.role === "partner" || (user.sections ?? []).includes("shares");
  const [mode, setMode] = useState<"month" | "year">("month");
  const [ms, setMs] = useState(() => monthStart(new Date()));
  const [ys, setYs] = useState(() => yearStart(new Date()));
  const [printing, setPrinting] = useState(false);
  const now = new Date();
  const atLatest = mode === "month" ? iso(ms) === iso(monthStart(now)) : iso(ys) === iso(yearStart(now));

  return (
    <div className="page report-page">
      <div className="list-tools no-print">
        <div className="segmented" role="tablist" aria-label="گزارش">
          <button role="tab" aria-selected={mode === "month"} className={mode === "month" ? "on" : ""} onClick={() => setMode("month")}>ماهانه</button>
          <button role="tab" aria-selected={mode === "year"} className={mode === "year" ? "on" : ""} onClick={() => setMode("year")}>سالانه</button>
        </div>
        <div className="period-step">
          <button className="btn ghost small" onClick={() => (mode === "month" ? setMs(prevMonth(ms)) : setYs(prevYear(ys)))}>‹ {mode === "month" ? "ماه قبل" : "سال قبل"}</button>
          <strong>{mode === "month" ? `${monthName(ms)} ${yearNumber(ms)}` : `سال ${yearNumber(ys)}`}</strong>
          <button className="btn ghost small" disabled={atLatest} onClick={() => (mode === "month" ? setMs(nextMonth(ms)) : setYs(nextYear(ys)))}>{mode === "month" ? "ماه بعد" : "سال بعد"} ›</button>
        </div>
        <button className="btn" onClick={() => setPrinting(true)} disabled={printing}><Icon name="receipt" /> چاپ</button>
      </div>
      {mode === "month"
        ? <MonthReport ms={ms} canShares={canShares} printing={printing} onPrinted={() => setPrinting(false)} />
        : <YearReport ys={ys} canShares={canShares} printing={printing} onPrinted={() => setPrinting(false)} />}
    </div>
  );
}

/**
 * Prints `children` alone on A4 (the app itself is hidden while printing), once it is on
 * the page; `landscape` for the 12-month sheet.
 */
function PrintCopy({ on, landscape, onDone, children }: { on: boolean; landscape?: boolean; onDone: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!on) return;
    const style = document.createElement("style");
    style.textContent = `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm; }`;
    document.head.appendChild(style);
    const done = () => { style.remove(); onDone(); };
    window.addEventListener("afterprint", done, { once: true });
    const t = window.setTimeout(() => window.print(), 50);
    return () => { window.clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  return on ? createPortal(<div className="print-only report-print">{children}</div>, document.body) : null;
}

function printedOn() {
  return `چاپ ${formatDay(iso(new Date()))}`;
}

// ---------------------------------------------------------------------------
// One month

function MonthReport({ ms, canShares, printing, onPrinted }: { ms: Date; canShares: boolean; printing: boolean; onPrinted: () => void }) {
  const tomorrow = addDays(new Date(), 1);
  const next = nextMonth(ms);
  const end = next < tomorrow ? next : tomorrow;
  const current = end < next;
  const pm = prevMonth(ms);
  const ly = sameMonthLastYear(ms);
  const { data, failed, retry } = useLoad(async (signal) => {
    const ranges: Range[] = [
      { from: iso(ms), to: iso(end) },
      { from: iso(pm), to: iso(ms) },
      { from: iso(ly), to: iso(nextMonth(ly)) },
    ];
    const a = await loadRanges(ranges, true, signal);
    const salaries = await api.salaries({ from: iso(ms), to: iso(addDays(next, -1)) }, signal).catch(() => null);
    const owed = await api.owed({ scope: "all", q: "", limit: 500 }, signal).catch(() => null);
    return {
      cur: a.sum(ranges[0]), prev: a.sum(ranges[1]), last: a.sum(ranges[2]), expenseOrder: a.res.expense_order, salaries,
      owed: owed ? { n: owed.total, sum: owed.rows.reduce((t, r) => t + r.owed, 0) } : null,
    };
  }, [iso(ms), iso(end)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const title = `${monthName(ms)} ${yearNumber(ms)}`;
  const sheet = (
    <MonthSheet title={title} current={current} cur={data.cur} prev={data.prev} last={data.last}
      prevLabel={monthName(pm)} lastLabel={`${monthName(ly)} ${yearNumber(ly)}`}
      expenseOrder={data.expenseOrder} salaries={data.salaries} ms={ms} canShares={canShares} />
  );
  return (
    <>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`درآمد ${title}`} value={data.cur.income} unit="؋" compare={vs(data.prev.income, `نسبت به ${monthName(pm)}`)} />
        <Kpi icon="receipt" label="مصارف" value={data.cur.expenses} unit="؋" upIsGood={false} compare={vs(data.prev.expenses, `نسبت به ${monthName(pm)}`)} />
        <Kpi icon="chart" label="سود خالص" value={balance(data.cur)} unit="؋" compare={vs(balance(data.prev), `نسبت به ${monthName(pm)}`)} />
        {data.owed
          ? <Kpi icon="card" label="باقی نزد اعضا (امروز)" value={data.owed.sum} unit="؋" note={`${fa(data.owed.n)} دوره با پرداخت ناتمام`} />
          : <Kpi icon="users" label="عضو جدید" value={data.cur.new_members} unit="نفر" />}
      </section>
      {current && <p className="muted small">ماه {monthName(ms)} هنوز تمام نشده؛ این گزارش تا امروز است.</p>}
      <div className="glass report-sheet">{sheet}</div>
      <PrintCopy on={printing} onDone={onPrinted}>{sheet}</PrintCopy>
    </>
  );
}

function MonthSheet({ title, current, cur, prev, last, prevLabel, lastLabel, expenseOrder, salaries, ms, canShares }: {
  title: string; current: boolean; cur: Sum; prev: Sum; last: Sum; prevLabel: string; lastLabel: string;
  expenseOrder: string[]; salaries: SalaryPage | null; ms: Date; canShares: boolean;
}) {
  const cols = [{ s: cur, label: title }, { s: prev, label: prevLabel }, { s: last, label: lastLabel }].filter((c, i) => i === 0 || !blank(c.s));
  const sums = cols.map((c) => c.s);
  const incomeCats = [...new Set(sums.flatMap((s) => Object.keys(s.income_by_category)))].sort((a, b) => rankIncome(a) - rankIncome(b));
  const order = (c: string) => (expenseOrder.includes(c) ? expenseOrder.indexOf(c) : 999);
  const expenseCats = [...new Set(sums.flatMap((s) => Object.keys(s.expenses_by_category)))].sort((a, b) => order(a) - order(b));
  const row = (label: string, v: (s: Sum) => number, cls = "") => (
    <tr key={label} className={cls}>
      <th scope="row">{label}</th>
      {sums.map((s, i) => <td key={i} className={i === 0 ? "remarks" : ""}>{fa(v(s))}</td>)}
    </tr>
  );
  const section = (label: string) => <tr className="section"><th scope="row" colSpan={sums.length + 1}>{label}</th></tr>;
  // The salary page counts months by their Solar year and number.
  const { y: sy, m: sm } = toSolar(ms);
  const staff = (salaries?.people ?? []).map((p) => ({ p, m: p.months.find((x) => x.year === sy && x.month === sm) })).filter((x) => x.m && (x.m.accrued || x.m.taken));
  const parts = shares(cur);

  return (
    <article className="report" dir="rtl">
      <header className="report-head">
        <div>
          <h1>گزارش مالی {title}</h1>
          <p>کتابخانه و سالن مطالعه پژوهش{current ? " · تا امروز" : ""}</p>
        </div>
        <span className="muted small">{printedOn()}</span>
      </header>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead><tr><th>شرح</th>{cols.map((c, i) => <th key={i} className={i === 0 ? "remarks" : ""}>{c.label}</th>)}</tr></thead>
          <tbody>
            {section("درآمد")}
            {incomeCats.map((c) => row(LABELS[c] ?? c, (s) => s.income_by_category[c] ?? 0))}
            {row("مجموع درآمد", (s) => s.income, "sum")}
            {section("مصارف")}
            {expenseCats.map((c) => row(c, (s) => s.expenses_by_category[c] ?? 0))}
            {row("مجموع مصارف", (s) => s.expenses, "sum")}
            {sums.some((s) => s.estimated !== 0) && row("بیلانس برآوردی (دستی)", (s) => s.estimated)}
            {row("بیلانس (سود خالص)", balance, "net")}
            {canShares && section("سهم شرکا")}
            {canShares && PARTNERS.map((p) => row(`سهمیه ${p.short}`, (s) => shares(s).find((x) => x.name === p.name)!.share))}
            {canShares && PARTNERS.map((p) => row(`برداشت ${p.short}`, (s) => s.withdrawals_by_person[p.name] ?? 0))}
          </tbody>
        </table>
      </div>
      {canShares && (
        <p className="muted small">
          سهم ناصری = (بیلانس + {MANAGER_SALARY}) ÷ 3؛ سهم رحیمی = دو برابر آن منهای {MANAGER_SALARY}.
          {parts.map((p) => ` مانده ${p.short} در این ماه: ${fa(p.left)}.`).join("")}
        </p>
      )}
      {staff.length > 0 && (
        <>
          <h2>معاش کارمندان در {title}</h2>
          <div className="table-wrap flush">
            <table className="table sheet">
              <thead><tr><th>کارمند</th><th>معاش این ماه</th><th>گرفته در این ماه</th><th>حساب تا امروز</th></tr></thead>
              <tbody>
                {staff.map(({ p, m }) => (
                  <tr key={p.id}>
                    <th scope="row">{p.full_name}{p.title && <span className="muted small"> · {p.title}</span>}</th>
                    <td>{fa(m!.accrued)}</td>
                    <td>{fa(m!.taken)}</td>
                    <td>{p.balance > 0 ? `طلب ${fa(p.balance)}` : p.balance < 0 ? `پیش‌گرفته ${fa(-p.balance)}` : "تسویه"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// One year, month by month

function YearReport({ ys, canShares, printing, onPrinted }: { ys: Date; canShares: boolean; printing: boolean; onPrinted: () => void }) {
  const tomorrow = addDays(new Date(), 1);
  const months = monthsOfYear(ys);
  const { data, failed, retry } = useLoad(async (signal) => {
    const ranges: Range[] = [];
    for (let i = 0; i < 12 && months[i] < tomorrow; i++) {
      ranges.push({ from: iso(months[i]), to: iso(months[i + 1] < tomorrow ? months[i + 1] : tomorrow) });
    }
    const a = await loadRanges(ranges.length ? ranges : [{ from: iso(ys), to: iso(addDays(ys, 1)) }], true, signal);
    const lastYear = await loadRanges([{ from: iso(prevYear(ys)), to: iso(ys) }], false, signal);
    return { byMonth: ranges.map(a.sum), year: total(a.res.periods), expenseOrder: a.res.expense_order, prev: lastYear.sum({ from: iso(prevYear(ys)), to: iso(ys) }) };
  }, [iso(ys), iso(tomorrow)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const y = yearNumber(ys);
  const py = yearNumber(prevYear(ys));
  const done = nextYear(ys) <= tomorrow;
  const sheet = <YearSheet y={y} months={months.slice(0, 12)} byMonth={data.byMonth} year={data.year} expenseOrder={data.expenseOrder} canShares={canShares} done={done} />;
  return (
    <>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`درآمد سال ${y}`} value={data.year.income} unit="؋" compare={vs(data.prev.income, `نسبت به کل سال ${py}`)} />
        <Kpi icon="receipt" label="مصارف" value={data.year.expenses} unit="؋" upIsGood={false} compare={vs(data.prev.expenses, `نسبت به کل سال ${py}`)} />
        <Kpi icon="chart" label="سود خالص" value={balance(data.year)} unit="؋" compare={vs(balance(data.prev), `نسبت به کل سال ${py}`)} />
        <Kpi icon="users" label="عضو جدید" value={data.year.new_members} unit="نفر" />
      </section>
      <div className="glass report-sheet">{sheet}</div>
      <PrintCopy on={printing} landscape onDone={onPrinted}>{sheet}</PrintCopy>
    </>
  );
}

function YearSheet({ y, months, byMonth, year, expenseOrder, canShares, done }: {
  y: string; months: Date[]; byMonth: Sum[]; year: Sum; expenseOrder: string[]; canShares: boolean; done: boolean;
}) {
  const incomeCats = Object.keys(year.income_by_category).sort((a, b) => rankIncome(a) - rankIncome(b));
  const order = (c: string) => (expenseOrder.includes(c) ? expenseOrder.indexOf(c) : 999);
  const expenseCats = Object.keys(year.expenses_by_category).sort((a, b) => order(a) - order(b) || year.expenses_by_category[b] - year.expenses_by_category[a]);
  const cell = (i: number, v: (s: Sum) => number) => (i < byMonth.length ? fa(v(byMonth[i])) : "—");
  const row = (label: string, v: (s: Sum) => number, cls = "") => (
    <tr key={label} className={cls}>
      <th scope="row">{label}</th>
      {months.map((_, i) => <td key={i}>{cell(i, v)}</td>)}
      <td className="remarks">{fa(v(year))}</td>
    </tr>
  );
  const section = (label: string) => <tr className="section"><th scope="row" colSpan={months.length + 2}>{label}</th></tr>;
  const of = (name: string, k: "share" | "taken" | "left") => (s: Sum) => shares(s).find((p) => p.name === name)![k];
  return (
    <article className="report" dir="rtl">
      <header className="report-head">
        <div>
          <h1>صورت حساب سال {y}</h1>
          <p>کتابخانه و سالن مطالعه پژوهش{done ? "" : " · سال هنوز تمام نشده، تا امروز"}</p>
        </div>
        <span className="muted small">{printedOn()} · ستون ملاحظات = جمع سال</span>
      </header>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead><tr><th>شرح</th>{months.map((m) => <th key={iso(m)}>{monthName(m)}</th>)}<th className="remarks">ملاحظات</th></tr></thead>
          <tbody>
            {section("درآمد")}
            {incomeCats.map((c) => row(LABELS[c] ?? c, (s) => s.income_by_category[c] ?? 0))}
            {row("مجموع درآمد", (s) => s.income, "sum")}
            {section("مصارف")}
            {expenseCats.map((c) => row(c, (s) => s.expenses_by_category[c] ?? 0))}
            {row("مجموع مصارفات", (s) => s.expenses, "sum")}
            {year.estimated !== 0 && row("بیلانس برآوردی (دستی)", (s) => s.estimated)}
            {row("بیلانس (سود خالص)", balance, "net")}
            {canShares && section("سهمیه")}
            {canShares && PARTNERS.map((p) => row(`سهمیه ${p.short}`, of(p.name, "share"), "sum"))}
            {canShares && section("برداشت")}
            {canShares && PARTNERS.map((p) => row(`برداشت ${p.short}`, of(p.name, "taken")))}
            {canShares && section("مانده (سهم منهای برداشت)")}
            {canShares && PARTNERS.map((p) => row(`مانده ${p.short}`, of(p.name, "left"), "sum"))}
            {canShares && row("موجودی", (s) => shares(s).reduce((t, p) => t + p.left, 0), "net")}
          </tbody>
        </table>
      </div>
    </article>
  );
}
