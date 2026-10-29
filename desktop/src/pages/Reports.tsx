import { useEffect, useState } from "react";
import {
  addDays, daysBetween, fa, formatDay, iso, monthName, monthStart, monthsOfYear, nextMonth, nextYear, prevMonth, prevYear,
  sameMonthLastYear, toSolar, yearNumber, yearStart,
} from "../lib/solar";
import { balance, loadRanges, total, type Range, type Sum } from "../lib/reports";
import { MANAGER_SALARY, PARTNERS, shares } from "../lib/shares";
import { useLoad } from "../lib/useLoad";
import { api, type HotspotPeriod, type SalaryPage } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Failed, Kpi, Loading } from "../components/Stat";
import { LABELS } from "../components/charts/CategoryBars";
import { Icon } from "../components/Icon";
import { PrintCopy } from "../components/PrintCopy";

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
  const [mode, setMode] = useState<"month" | "year" | "hotspot">("month");
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
          <button role="tab" aria-selected={mode === "hotspot"} className={mode === "hotspot" ? "on" : ""} onClick={() => setMode("hotspot")}>هات‌اسپات</button>
        </div>
        <div className="period-step">
          <button className="btn ghost small" onClick={() => (mode === "month" ? setMs(prevMonth(ms)) : setYs(prevYear(ys)))}>‹ {mode === "month" ? "ماه قبل" : "سال قبل"}</button>
          <strong>{mode === "month" ? `${monthName(ms)} ${yearNumber(ms)}` : `سال ${yearNumber(ys)}`}</strong>
          <button className="btn ghost small" disabled={atLatest} onClick={() => (mode === "month" ? setMs(nextMonth(ms)) : setYs(nextYear(ys)))}>{mode === "month" ? "ماه بعد" : "سال بعد"} ›</button>
        </div>
        <button className="btn" onClick={() => setPrinting(true)} disabled={printing}><Icon name="receipt" /> چاپ</button>
      </div>
      {mode === "month" && <MonthReport ms={ms} canShares={canShares} printing={printing} onPrinted={() => setPrinting(false)} />}
      {mode === "year" && <YearReport ys={ys} canShares={canShares} printing={printing} onPrinted={() => setPrinting(false)} />}
      {mode === "hotspot" && <HotspotReport ys={ys} printing={printing} onPrinted={() => setPrinting(false)} />}
    </div>
  );
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
  // While the month runs, the other months are compared over the same first days only.
  const span = daysBetween(ms, end);
  const upTo = (from: Date, cap: Date) => (current ? (addDays(from, span) < cap ? addDays(from, span) : cap) : cap);
  const days = current ? ` (1 تا ${span})` : "";
  const { data, failed, retry } = useLoad(async (signal) => {
    const ranges: Range[] = [
      { from: iso(ms), to: iso(end) },
      { from: iso(pm), to: iso(upTo(pm, ms)) },
      { from: iso(ly), to: iso(upTo(ly, nextMonth(ly))) },
    ];
    const a = await loadRanges(ranges, true, signal);
    const salaries = await api.salaries({ from: iso(ms), to: iso(addDays(next, -1)) }, signal).catch(() => null);
    const owed = await api.owed({ scope: "all", q: "", limit: 1 }, signal).catch(() => null);
    return {
      cur: a.sum(ranges[0]), prev: a.sum(ranges[1]), last: a.sum(ranges[2]), expenseOrder: a.res.expense_order, salaries,
      owed: owed ? { n: owed.total, sum: owed.sum } : null,
    };
  }, [iso(ms), iso(end)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const title = `${monthName(ms)} ${yearNumber(ms)}`;
  const sheet = (
    <MonthSheet title={title} current={current} cur={data.cur} prev={data.prev} last={data.last}
      prevLabel={`${monthName(pm)}${days}`} lastLabel={`${monthName(ly)} ${yearNumber(ly)}${days}`}
      expenseOrder={data.expenseOrder} salaries={data.salaries} ms={ms} canShares={canShares} />
  );
  return (
    <>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`درآمد ${title}`} value={data.cur.income} unit="؋" compare={vs(data.prev.income, `نسبت به ${monthName(pm)}${days}`)} />
        <Kpi icon="receipt" label="مصارف" value={data.cur.expenses} unit="؋" upIsGood={false} compare={vs(data.prev.expenses, `نسبت به ${monthName(pm)}${days}`)} />
        <Kpi icon="chart" label="سود خالص" value={balance(data.cur)} unit="؋" compare={vs(balance(data.prev), `نسبت به ${monthName(pm)}${days}`)} />
        {data.owed
          ? <Kpi icon="card" label="باقی نزد اعضا (امروز)" value={data.owed.sum} unit="؋" note={`${fa(data.owed.n)} دوره با پرداخت ناتمام`} />
          : <Kpi icon="card" label="باقی نزد اعضا (امروز)" value={NaN} unit="" note={<button className="link" onClick={retry}>خوانده نشد؛ دوباره</button>} />}
      </section>
      {current && <p className="muted small">ماه {monthName(ms)} هنوز تمام نشده؛ این گزارش تا امروز است و ماه‌های دیگر هم فقط در همین {span} روز اول مقایسه شده‌اند.</p>}
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
    // While the year runs, last year is compared over the same days only.
    const py0 = prevYear(ys);
    const pyEnd = nextYear(ys) > tomorrow && addDays(py0, daysBetween(ys, tomorrow)) < ys ? addDays(py0, daysBetween(ys, tomorrow)) : ys;
    const prevRange = { from: iso(py0), to: iso(pyEnd) };
    const lastYear = await loadRanges([prevRange], false, signal);
    return { byMonth: ranges.map(a.sum), year: total(a.res.periods), expenseOrder: a.res.expense_order, prev: lastYear.sum(prevRange) };
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
        <Kpi hero icon="wallet" label={`درآمد سال ${y}`} value={data.year.income} unit="؋" compare={vs(data.prev.income, (done ? `نسبت به کل سال ${py}` : `نسبت به همین مدت سال ${py}`))} />
        <Kpi icon="receipt" label="مصارف" value={data.year.expenses} unit="؋" upIsGood={false} compare={vs(data.prev.expenses, (done ? `نسبت به کل سال ${py}` : `نسبت به همین مدت سال ${py}`))} />
        <Kpi icon="chart" label="سود خالص" value={balance(data.year)} unit="؋" compare={vs(balance(data.prev), (done ? `نسبت به کل سال ${py}` : `نسبت به همین مدت سال ${py}`))} />
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

/**
 * The hotspot on its own, month by month: cards bought and sold, the profit on the cards
 * sold, what the statement counted as income, and the cards left at each month's end.
 * Its income stays in the statement's total; this is the closer look.
 */
function HotspotReport({ ys, printing, onPrinted }: { ys: Date; printing: boolean; onPrinted: () => void }) {
  const tomorrow = addDays(new Date(), 1);
  const months = monthsOfYear(ys);
  const { data, failed, retry } = useLoad(async (signal) => {
    const bounds = [iso(ys)];
    for (let i = 1; i <= 12 && months[i - 1] < tomorrow; i++) bounds.push(iso(months[i] < tomorrow ? months[i] : tomorrow));
    return api.hotspotReport(bounds.length > 1 ? bounds : [iso(ys), iso(addDays(ys, 1))], signal);
  }, [iso(ys), iso(tomorrow)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const y = yearNumber(ys);
  const p = data.periods;
  const sum = (k: keyof HotspotPeriod) => p.reduce((t, x) => t + x[k], 0);
  const end = p[p.length - 1];
  const profit = sum("sales") - sum("cost");
  const sheet = <HotspotSheet y={y} months={months.slice(0, 12)} periods={p} done={nextYear(ys) <= tomorrow} />;
  return (
    <>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`سود هات‌اسپات ${y}`} value={profit} unit="؋" note={<span className="muted small">فروش منهای قیمت خرید کارت‌های فروخته</span>} />
        <Kpi icon="receipt" label="فروش" value={sum("sales")} unit="؋" note={<span className="muted small">{fa(sum("cards_sold"))} کارت</span>} />
        <Kpi icon="chart" label="خرید" value={sum("bought")} unit="؋" upIsGood={false} note={<span className="muted small">{fa(sum("cards_bought"))} کارت</span>} />
        <Kpi icon="wifi" label="کارت‌های موجود" value={end?.stock_cards ?? 0} unit="کارت" note={<span className="muted small">به قیمت خرید {fa(end?.stock_value ?? 0)} ؋</span>} />
      </section>
      <div className="glass report-sheet">{sheet}</div>
      {data.stock.length > 0 && (
        <section className="glass table-wrap">
          <table className="table">
            <caption>کارت‌های موجود {nextYear(ys) <= tomorrow ? `در آخر سال ${y}` : "تا امروز"}</caption>
            <thead><tr><th>کارت</th><th>تعداد</th><th>ارزش به قیمت خرید</th></tr></thead>
            <tbody>
              {data.stock.map((s) => (
                <tr key={s.volume_gb} className={s.in_hand < 0 ? "differs" : ""}>
                  <td><bdi dir="ltr">{s.volume_gb}GB</bdi></td>
                  <td className="num">{fa(s.in_hand)}{s.in_hand < 0 && <span className="muted small"> (فروش بیشتر از خرید ثبت شده)</span>}</td>
                  <td className="num">{fa(s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <PrintCopy on={printing} landscape onDone={onPrinted}>{sheet}</PrintCopy>
    </>
  );
}

function HotspotSheet({ y, months, periods, done }: { y: string; months: Date[]; periods: HotspotPeriod[]; done: boolean }) {
  const cell = (i: number, v: (s: HotspotPeriod) => number) => (i < periods.length ? fa(v(periods[i])) : "—");
  const total = (v: (s: HotspotPeriod) => number) => periods.reduce((t, s) => t + v(s), 0);
  const row = (label: string, v: (s: HotspotPeriod) => number, cls = "", year: number | null = total(v)) => (
    <tr key={label} className={cls}>
      <th scope="row">{label}</th>
      {months.map((_, i) => <td key={i}>{cell(i, v)}</td>)}
      <td className="remarks">{year === null ? "" : fa(year)}</td>
    </tr>
  );
  const section = (label: string) => <tr className="section"><th scope="row" colSpan={months.length + 2}>{label}</th></tr>;
  const last = periods[periods.length - 1];
  const profit = (s: HotspotPeriod) => s.sales - s.cost;
  const differs = periods.some((s) => Math.abs(s.income - profit(s)) >= 1);
  return (
    <article className="report" dir="rtl">
      <header className="report-head">
        <div>
          <h1>گزارش هات‌اسپات سال {y}</h1>
          <p>کتابخانه و سالن مطالعه پژوهش{done ? "" : " · سال هنوز تمام نشده، تا امروز"}</p>
        </div>
        <span className="muted small">{printedOn()} · ستون ملاحظات = جمع سال (موجودی: آخرین ماه)</span>
      </header>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead><tr><th>شرح</th>{months.map((m) => <th key={iso(m)}>{monthName(m)}</th>)}<th className="remarks">ملاحظات</th></tr></thead>
          <tbody>
            {section("خرید")}
            {row("کارت‌های خریده شده", (s) => s.cards_bought)}
            {row("GB خریده شده", (s) => s.gb_bought)}
            {row("مبلغ خرید", (s) => s.bought, "sum")}
            {section("فروش")}
            {row("کارت‌های فروخته شده", (s) => s.cards_sold)}
            {row("GB فروخته شده", (s) => s.gb_sold)}
            {row("مبلغ فروش", (s) => s.sales, "sum")}
            {row("قیمت خرید کارت‌های فروخته", (s) => s.cost)}
            {section("سود و زیان")}
            {row("سود فروش (فروش منهای قیمت خرید)", profit, "net")}
            {row("در درآمد صورت حساب آمده", (s) => s.income)}
            {row("فرق نقدی ماه (فروش منهای خرید)", (s) => s.sales - s.bought)}
            {section("موجودی آخر ماه")}
            {row("کارت", (s) => s.stock_cards, "", last?.stock_cards ?? 0)}
            {row("GB", (s) => s.stock_gb, "", last?.stock_gb ?? 0)}
            {row("ارزش به قیمت خرید", (s) => s.stock_value, "sum", last?.stock_value ?? 0)}
          </tbody>
        </table>
      </div>
      {differs && (
        <p className="muted small">
          ماهی که «در درآمد صورت حساب آمده» با «سود فروش» فرق دارد، عدد شیت «محاسبات» اکسل در درآمد شمرده شده است.
          «فرق نقدی» منفی یعنی آن ماه بیشتر کارت خریده شده تا فروخته؛ آن کارت‌ها در موجودی هستند.
        </p>
      )}
    </article>
  );
}
