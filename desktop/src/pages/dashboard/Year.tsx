import { addDays, daysBetween, fa, formatShort, iso, monthName, monthsOfYear, nextYear, parseIso, prevYear, yearNumber, yearStart } from "../../lib/solar";
import { loadRanges, total, type Range, type Sum } from "../../lib/reports";
import { useLoad } from "../../lib/useLoad";
import { Failed, Figure, Kpi, Loading } from "../../components/Stat";
import { TrendChart } from "../../components/charts/TrendChart";
import { LABELS } from "../../components/charts/CategoryBars";

const INCOME_ORDER = Object.keys(LABELS);

/**
 * This Solar year: the months so far, the monthly statement with a year-total column
 * ("ملاحظات" in the Excel book), and every year since the first record.
 */
export function YearView() {
  const now = new Date();
  const ys = yearStart(now);
  const lys = prevYear(ys);
  const tomorrow = addDays(now, 1);
  const n = daysBetween(ys, tomorrow);
  const months = monthsOfYear(ys);
  const lastYtd: Range = { from: iso(lys), to: iso(addDays(lys, n) < ys ? addDays(lys, n) : ys) };

  const { data, failed, retry } = useLoad(async (signal) => {
    // Months up to today, each capped at today, plus the same span of last year.
    const monthRanges: Range[] = [];
    for (let i = 0; i < 12 && months[i] < tomorrow; i++) {
      monthRanges.push({ from: iso(months[i]), to: iso(months[i + 1] < tomorrow ? months[i + 1] : tomorrow) });
    }
    const a = await loadRanges([...monthRanges, lastYtd], true, signal);
    const byMonth = monthRanges.map(a.sum);

    // One range per earlier Solar year, back to the year of the first receipt.
    const years: { start: Date; sum: Sum }[] = [];
    const first = a.res.first_day ? parseIso(a.res.first_day) : null;
    if (first && first < ys) {
      const starts = [yearStart(first)];
      while (starts[starts.length - 1] < ys) starts.push(nextYear(starts[starts.length - 1]));
      const ranges = starts.slice(0, -1).map((s, i) => ({ from: iso(s), to: iso(starts[i + 1]) }));
      const b = await loadRanges(ranges, false, signal);
      ranges.forEach((r, i) => years.push({ start: starts[i], sum: b.sum(r) }));
    }
    return {
      byMonth, cur: total(a.res.periods.filter((p) => p.from >= iso(ys))), last: a.sum(lastYtd), years, first,
      allTime: a.res.all_time_income, expenseOrder: a.res.expense_order,
    };
  }, [iso(now)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const { cur, last, byMonth } = data;
  const y = yearNumber(now);
  const vs = `نسبت به همین ${fa(n)} روز سال ${yearNumber(lys)}`;
  const net = (s: Sum) => s.income - s.expenses;

  return (
    <>
      <p className="muted period-note">از 1 حمل {y} تا امروز ({fa(n)} روز). مقایسه با همین مدت سال {yearNumber(lys)} است.</p>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`درآمد سال ${y}`} value={cur.income} unit="؋" compare={[{ prev: last.income, vs }]} />
        <Kpi icon="receipt" label={`مصارف سال ${y}`} value={cur.expenses} unit="؋" upIsGood={false} compare={[{ prev: last.expenses, vs }]} />
        <Kpi icon="chart" label={`سود خالص سال ${y}`} value={net(cur)} unit="؋" compare={[{ prev: net(last), vs }]} />
        <Kpi icon="card" label="درآمد کل دیتابیس" value={data.allTime} unit="؋"
          note={data.first ? `از ${formatShort(data.first)} ${yearNumber(data.first)} تا امروز` : "هنوز درآمدی ثبت نشده"} />
      </section>

      <section className="grid-2">
        <div className="glass panel-chart">
          <div className="panel-head">
            <h2>درآمد و مصارف ماهوار سال {y}</h2>
            <span className="muted small">ماه جاری هنوز تمام نشده</span>
          </div>
          <TrendChart
            data={byMonth.map((s, i) => ({ day: iso(months[i]), income: s.income, expenses: s.expenses }))}
            label={`درآمد و مصارف ماهوار سال ${y}`}
            tick={(p) => monthName(parseIso(p.day))}
            every={1}
          />
        </div>
        <History years={data.years} cur={cur} last={last} y={y} />
      </section>

      <Statement y={y} months={months.slice(0, 12)} byMonth={byMonth} cur={cur} expenseOrder={data.expenseOrder} />
    </>
  );
}

/** Every Solar year side by side, each against the one before it. */
function History({ years, cur, last, y }: { years: { start: Date; sum: Sum }[]; cur: Sum; last: Sum; y: string }) {
  const net = (s: Sum) => s.income - s.expenses;
  const rows = [
    ...years.map((r, i) => ({ label: yearNumber(r.start), sum: r.sum, prev: i ? years[i - 1].sum : null })),
    { label: `${y} (تا امروز)`, sum: cur, prev: years.length ? last : null },
  ].reverse();
  return (
    <div className="glass">
      <div className="panel-head"><h2>گزارش همهٔ سال‌ها</h2></div>
      <div className="table-wrap flush">
        <table className="table compare">
          <thead><tr><th>سال</th><th>درآمد</th><th>مصارف</th><th>سود خالص</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td><Figure value={r.sum.income} prev={r.prev?.income ?? null} /></td>
                <td><Figure value={r.sum.expenses} prev={r.prev?.expenses ?? null} upIsGood={false} /></td>
                <td><Figure value={net(r.sum)} prev={r.prev ? net(r.prev) : null} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">درصدها رشد یا کاهش نسبت به سال قبل است؛ سال جاری با همین مدت سال گذشته مقایسه می‌شود.</p>
    </div>
  );
}

/**
 * Rows are categories, columns the 12 months, and the last column the year total, as in
 * the Excel statement (محاسبات): income, expenses, balance, each partner's withdrawals, cash left.
 */
function Statement({ y, months, byMonth, cur, expenseOrder }: { y: string; months: Date[]; byMonth: Sum[]; cur: Sum; expenseOrder: string[] }) {
  const incomeCats = Object.keys(cur.income_by_category).sort((a, b) => rank(a) - rank(b));
  const order = (c: string) => (expenseOrder.includes(c) ? expenseOrder.indexOf(c) : 999);
  const expenseCats = Object.keys(cur.expenses_by_category).sort((a, b) => order(a) - order(b) || cur.expenses_by_category[b] - cur.expenses_by_category[a]);
  const people = Object.keys(cur.withdrawals_by_person).sort();
  const taken = (s: Sum) => Object.values(s.withdrawals_by_person).reduce((t, v) => t + v, 0);
  const cell = (i: number, v: (s: Sum) => number) => (i < byMonth.length ? fa(v(byMonth[i])) : "—");
  const row = (label: string, v: (s: Sum) => number, cls = "") => (
    <tr key={label} className={cls}>
      <th scope="row">{label}</th>
      {months.map((_, i) => <td key={i}>{cell(i, v)}</td>)}
      <td className="remarks">{fa(v(cur))}</td>
    </tr>
  );
  const section = (label: string) => (
    <tr className="section"><th scope="row" colSpan={months.length + 2}>{label}</th></tr>
  );
  return (
    <section className="glass statement">
      <div className="panel-head">
        <h2>صورت حساب ماهوار سال {y}</h2>
        <span className="muted small">ستون ملاحظات = جمع سال</span>
      </div>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead>
            <tr><th>شرح</th>{months.map((m) => <th key={iso(m)}>{monthName(m)}</th>)}<th className="remarks">ملاحظات</th></tr>
          </thead>
          <tbody>
            {section("درآمد")}
            {incomeCats.map((c) => row(LABELS[c] ?? c, (s) => s.income_by_category[c] ?? 0))}
            {row("مجموع درآمد", (s) => s.income, "sum")}
            {section("مصارف")}
            {expenseCats.map((c) => row(c, (s) => s.expenses_by_category[c] ?? 0))}
            {row("مجموع مصارفات", (s) => s.expenses, "sum")}
            {row("بیلانس (سود خالص)", (s) => s.income - s.expenses, "net")}
            {people.length > 0 && section("برداشت‌ها")}
            {people.map((p) => row(`برداشت ${p}`, (s) => s.withdrawals_by_person[p] ?? 0))}
            {people.length > 0 && row("موجودی (بیلانس منهای برداشت‌ها)", (s) => s.income - s.expenses - taken(s), "sum")}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const rank = (c: string) => (INCOME_ORDER.includes(c) ? INCOME_ORDER.indexOf(c) : 99);
