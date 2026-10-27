import { useEffect, useState } from "react";
import { addDays, daysBetween, fa, formatShort, iso, monthName, monthsOfYear, nextYear, parseIso, prevYear, yearNumber, yearStart } from "../../lib/solar";
import { balance, loadRanges, total, type Range, type Sum } from "../../lib/reports";
import { useLoad } from "../../lib/useLoad";
import { Failed, Figure, Kpi, Loading } from "../../components/Stat";
import { TrendChart } from "../../components/charts/TrendChart";
import { LABELS } from "../../components/charts/CategoryBars";
import { api, errorText, type MonthSummary, type SalaryPage } from "../../lib/api";
import { AmountInput } from "../../components/AmountInput";
import { useAuth } from "../../auth/AuthProvider";
import { useToast } from "../../components/Toast";

const INCOME_ORDER = Object.keys(LABELS);

/**
 * One Solar year (this one by default): the months, the monthly statement with a year-total
 * column ("ملاحظات" in the Excel book), and every year since the first record.
 */
export function YearView() {
  const now = new Date();
  const [ys, setYs] = useState(() => yearStart(now));
  const current = iso(ys) === iso(yearStart(now));
  const lys = prevYear(ys);
  // This year runs to today; an earlier one is whole.
  const end = current ? addDays(now, 1) : nextYear(ys);
  const n = daysBetween(ys, end);
  const months = monthsOfYear(ys);
  const lastSpan: Range = { from: iso(lys), to: iso(addDays(lys, n) < ys ? addDays(lys, n) : ys) };

  const { data, failed, retry } = useLoad(async (signal) => {
    const monthRanges: Range[] = [];
    for (let i = 0; i < 12 && months[i] < end; i++) {
      monthRanges.push({ from: iso(months[i]), to: iso(months[i + 1] < end ? months[i + 1] : end) });
    }
    const a = await loadRanges([...monthRanges, lastSpan], true, signal);
    const byMonth = monthRanges.map(a.sum);

    // One range per Solar year, back to the year of the first record.
    const years: { start: Date; sum: Sum }[] = [];
    const first = a.res.first_day ? parseIso(a.res.first_day) : null;
    const thisYear = yearStart(now);
    if (first && first < thisYear) {
      const starts = [yearStart(first)];
      while (starts[starts.length - 1] < thisYear) starts.push(nextYear(starts[starts.length - 1]));
      const ranges = starts.slice(0, -1).map((s, i) => ({ from: iso(s), to: iso(starts[i + 1]) }));
      const b = await loadRanges(ranges, false, signal);
      ranges.forEach((r, i) => years.push({ start: starts[i], sum: b.sum(r) }));
    }
    // Staff salaries, for the "if everyone had been paid exactly their salary" table.
    const salaries = await api.salaries({ from: iso(ys), to: iso(addDays(nextYear(ys), -1)) }, signal).catch(() => null);
    return {
      salaries, byMonth, cur: total(a.res.periods.filter((p) => p.from >= iso(ys) && p.to <= iso(end))), last: a.sum(lastSpan), years, first,
      allTime: a.res.all_time_income, expenseOrder: a.res.expense_order,
    };
  }, [iso(now), iso(ys)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const { cur, last, byMonth } = data;
  const y = yearNumber(ys);
  const vs = current ? `نسبت به همین ${fa(n)} روز سال ${yearNumber(lys)}` : `نسبت به سال ${yearNumber(lys)}`;
  const earliest = data.first ? yearStart(data.first) : yearStart(now);

  return (
    <>
      <div className="year-head">
        <div className="period-step">
          <button className="btn ghost small" disabled={ys <= earliest} onClick={() => setYs(prevYear(ys))}>‹ سال قبل</button>
          <strong>سال {y}</strong>
          <button className="btn ghost small" disabled={current} onClick={() => setYs(nextYear(ys))}>سال بعد ›</button>
        </div>
        <p className="muted period-note">
          {current ? `از 1 حمل ${y} تا امروز (${fa(n)} روز). مقایسه با همین مدت سال ${yearNumber(lys)} است.` : `سال کامل ${y}، مقایسه با سال ${yearNumber(lys)}.`}
          {cur.estimated !== 0 && " بعضی ماه‌های این سال فقط بیلانس برآوردی دارند."}
        </p>
      </div>
      <section className="kpis four">
        <Kpi hero icon="wallet" label={`درآمد سال ${y}`} value={cur.income} unit="؋" compare={[{ prev: last.income, vs }]} />
        <Kpi icon="receipt" label={`مصارف سال ${y}`} value={cur.expenses} unit="؋" upIsGood={false} compare={[{ prev: last.expenses, vs }]} />
        <Kpi icon="chart" label={`سود خالص سال ${y}`} value={balance(cur)} unit="؋" compare={[{ prev: balance(last), vs }]} />
        <Kpi icon="card" label="درآمد کل دیتابیس" value={data.allTime} unit="؋"
          note={data.first ? `از ${formatShort(data.first)} ${yearNumber(data.first)} تا امروز` : "هنوز درآمدی ثبت نشده"} />
      </section>

      <section className="grid-2">
        <div className="glass panel-chart">
          <div className="panel-head">
            <h2>درآمد و مصارف ماهوار سال {y}</h2>
            {current && <span className="muted small">ماه جاری هنوز تمام نشده</span>}
          </div>
          <TrendChart
            data={byMonth.map((s, i) => ({ day: iso(months[i]), income: s.income, expenses: s.expenses }))}
            label={`درآمد و مصارف ماهوار سال ${y}`}
            tick={(p) => monthName(parseIso(p.day))}
            every={1}
          />
        </div>
        <History years={data.years} cur={current ? cur : null} last={last} />
      </section>

      <Statement y={y} months={months.slice(0, 12)} byMonth={byMonth} cur={cur} expenseOrder={data.expenseOrder} />
      {cur.estimated !== 0 && <Estimates year={Number(y)} onSaved={retry} />}
      {data.salaries && <AtFixedSalary y={y} months={months.slice(0, 12)} byMonth={byMonth} salaries={data.salaries} />}
    </>
  );
}

/** Every Solar year side by side, each against the one before it. */
function History({ years, cur, last }: { years: { start: Date; sum: Sum }[]; cur: Sum | null; last: Sum }) {
  const net = balance;
  const rows = [
    ...years.map((r, i) => ({ label: yearNumber(r.start), sum: r.sum, prev: i ? years[i - 1].sum : null })),
    ...(cur ? [{ label: `${yearNumber(new Date())} (تا امروز)`, sum: cur, prev: years.length ? last : null }] : []),
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
            {cur.estimated !== 0 && row("بیلانس برآوردی (دستی، بدون جزئیات)", (s) => s.estimated)}
            {row("بیلانس (سود خالص)", balance, "net")}
            {people.length > 0 && section("برداشت‌ها")}
            {people.map((p) => row(`برداشت ${p}`, (s) => s.withdrawals_by_person[p] ?? 0))}
            {people.length > 0 && row("موجودی (بیلانس منهای برداشت‌ها)", (s) => balance(s) - taken(s), "sum")}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const rank = (c: string) => (INCOME_ORDER.includes(c) ? INCOME_ORDER.indexOf(c) : 99);

/**
 * The statement counts what staff were really paid. This table shows each month as if they
 * had been paid exactly their fixed salary: their paid lines out, the fixed salaries in.
 */
function AtFixedSalary({ y, months, byMonth, salaries }: { y: string; months: Date[]; byMonth: Sum[]; salaries: SalaryPage }) {
  const year = Number(y);
  const staff = salaries.people.filter((p) => p.category && p.months.some((m) => m.year === year && m.accrued > 0));
  if (!staff.length) return null;
  const lines = [...new Set(staff.map((p) => p.category!))];
  const fixed = (i: number) => staff.reduce((t, p) => t + (p.months.find((m) => m.year === year && m.month === i + 1)?.accrued ?? 0), 0);
  const paid = (s: Sum) => lines.reduce((t, c) => t + (s.expenses_by_category[c] ?? 0), 0);
  const atFixed = (s: Sum, i: number) => balance(s) + paid(s) - fixed(i);
  const rows: { label: string; v: (s: Sum, i: number) => number; cls?: string }[] = [
    { label: "مجموع درآمد", v: (s) => s.income },
    { label: "مجموع مصارفات با معاش ثابت", v: (s, i) => s.expenses - paid(s) + fixed(i) },
    { label: "سود خالص با معاش ثابت", v: atFixed, cls: "net" },
  ];
  const yearTotal = (v: (s: Sum, i: number) => number) => byMonth.reduce((t, s, i) => t + v(s, i), 0);
  const diff = yearTotal((s, i) => paid(s) - fixed(i));
  return (
    <section className="glass statement">
      <div className="panel-head">
        <h2>اگر معاش ثابت داده می‌شد، سال {y}</h2>
        <span className={`status ${diff >= 0 ? "on" : "wait"}`}>
          {diff >= 0 ? "سود بیشتر" : "سود کمتر"} {fa(Math.abs(diff))} ؋ نسبت به صورت حساب
        </span>
      </div>
      <p className="muted small">
        هر کارمند ({staff.map((p) => p.full_name).join("، ")}) هر ماه دقیقاً معاش ثابتش را گرفته فرض شده، به جای پولی که در سطرهای {lines.map((l) => `«${l}»`).join("، ")} واقعاً گرفته.
      </p>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead>
            <tr><th>شرح</th>{months.map((m) => <th key={iso(m)}>{monthName(m)}</th>)}<th className="remarks">ملاحظات</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.cls ?? ""}>
                <th scope="row">{r.label}</th>
                {months.map((_, i) => <td key={i}>{i < byMonth.length ? fa(r.v(byMonth[i], i)) : "—"}</td>)}
                <td className="remarks">{fa(yearTotal(r.v))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The months of the year known only by a hand-made balance; partners can correct them. */
function Estimates({ year, onSaved }: { year: number; onSaved: () => void }) {
  const partner = useAuth().user?.role === "partner";
  const toast = useToast();
  const [rows, setRows] = useState<MonthSummary[] | null>(null);
  const [edit, setEdit] = useState<{ id: string; amount: string; note: string } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    api.monthSummaries(year, ctl.signal).then(setRows).catch(() => {});
    return () => ctl.abort();
  }, [year]);
  if (!rows?.length) return null;
  async function save() {
    if (!edit) return;
    if (edit.amount === "" || !Number.isFinite(Number(edit.amount))) return setError("مبلغ را بنویسید.");
    try {
      await api.updateMonthSummary(edit.id, { net_balance: Number(edit.amount), note: edit.note });
      setRows((r) => r!.map((x) => (x.id === edit.id ? { ...x, net_balance: Number(edit.amount), note: edit.note || null } : x)));
      setEdit(null);
      setError("");
      toast("بیلانس برآوردی اصلاح شد.");
      onSaved();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="glass statement">
      <div className="panel-head"><h2>ماه‌های برآوردی سال {year}</h2><span className="muted small">جزئیات این ماه‌ها در دست نیست؛ فقط بیلانس دستی شرکا</span></div>
      <div className="table-wrap flush">
        <table className="table">
          <thead><tr><th>ماه</th><th className="num">بیلانس</th><th>یادداشت</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {rows.map((r) => edit?.id === r.id ? (
              <tr key={r.id}>
                <td>{monthName(parseIso(r.starts_on))}</td>
                <td><AmountInput label="بیلانس" wide={false} value={edit.amount} onChange={(v) => setEdit({ ...edit, amount: v })} autoFocus /></td>
                <td><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} aria-label="یادداشت" /></td>
                <td className="row-tools"><button className="btn small" onClick={() => void save()}>ذخیره</button><button className="btn small ghost" onClick={() => setEdit(null)}>انصراف</button></td>
              </tr>
            ) : (
              <tr key={r.id}>
                <td>{monthName(parseIso(r.starts_on))}</td>
                <td className="num">{fa(r.net_balance)}</td>
                <td className="muted">{r.note ?? "—"}</td>
                <td>{partner && <button className="btn small ghost" onClick={() => setEdit({ id: r.id, amount: String(r.net_balance), note: r.note ?? "" })}>اصلاح</button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th>جمع</th><td className="num">{fa(rows.reduce((t, r) => t + r.net_balance, 0))}</td><td colSpan={2} /></tr></tfoot>
        </table>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
