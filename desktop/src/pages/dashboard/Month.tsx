import { addDays, daysBetween, fa, iso, monthName, monthStart, nextMonth, prevMonth, sameMonthLastYear, yearNumber } from "../../lib/solar";
import { asBars, balance, loadRanges, total } from "../../lib/reports";
import { partnersTaken } from "../../lib/shares";
import { useAuth } from "../../auth/AuthProvider";
import { useLoad } from "../../lib/useLoad";
import { Failed, Figure, Kpi, Loading } from "../../components/Stat";
import { TrendChart } from "../../components/charts/TrendChart";
import { CategoryBars } from "../../components/charts/CategoryBars";

/**
 * This Solar month so far, against the same number of days of last month and of the
 * same month last year (e.g. 1 to 3 Aqrab 1405 vs 1 to 3 Mizan 1405 and 1 to 3 Aqrab 1404).
 */
export function MonthView() {
  const user = useAuth().user!;
  // The partners' withdrawals are theirs to see, as on the finance report.
  const canShares = user.role === "partner" || (user.sections ?? []).includes("shares");
  const now = new Date();
  const ms = monthStart(now);
  const me = nextMonth(ms);
  const end = addDays(now, 1) < me ? addDays(now, 1) : me;
  const n = daysBetween(ms, end);
  const pm = prevMonth(ms);
  const ly = sameMonthLastYear(ms);
  const cap = (start: Date, next: Date) => iso(addDays(start, n) < next ? addDays(start, n) : next);
  const days = Array.from({ length: n + 1 }, (_, i) => iso(addDays(ms, i)));

  const { data, failed, retry } = useLoad(async (signal) => {
    const { res, sum } = await loadRanges(
      [
        ...days.slice(0, -1).map((d, i) => ({ from: d, to: days[i + 1] })),
        { from: iso(pm), to: cap(pm, ms) },
        { from: iso(ly), to: cap(ly, nextMonth(ly)) },
      ],
      true,
      signal,
    );
    const daily = res.periods.filter((p) => p.from >= days[0]);
    return {
      cur: total(daily),
      prev: sum({ from: iso(pm), to: cap(pm, ms) }),
      last: sum({ from: iso(ly), to: cap(ly, nextMonth(ly)) }),
      trend: daily.map((p) => ({ day: p.from, income: p.income, expenses: p.expenses })),
    };
  }, [iso(now)]);

  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const { cur, prev, last } = data;
  const name = monthName(now);
  const vsPrev = `نسبت به ${monthName(pm)}`;
  const vsLast = `نسبت به ${monthName(ly)} ${yearNumber(ly)}`;
  const net = balance;
  // The month on its own: what is left of its profit after the partners took their part.
  // The till as a whole (with the months before) is on «امسال».
  const left = (s: typeof cur) => balance(s) - partnersTaken(s);
  const rows: { label: string; get: (s: typeof cur) => number; unit: string; upIsGood?: boolean }[] = [
    { label: "درآمد", get: (s) => s.income, unit: "؋" },
    { label: "مصارف", get: (s) => s.expenses, unit: "؋", upIsGood: false },
    { label: "سود خالص", get: net, unit: "؋" },
    ...(canShares ? [{ label: "باقی پس از برداشت", get: left, unit: "؋" }] : []),
    { label: "ثبت‌نام جدید", get: (s) => s.new_members, unit: "نفر" },
  ];

  return (
    <>
      <p className="muted period-note">
        {fa(n)} روز اول {name} {yearNumber(now)} ({n === daysBetween(ms, me) ? "ماه کامل" : "تا امروز"}). مقایسه‌ها با همین تعداد روز انجام می‌شود.
      </p>
      <section className={`kpis ${canShares ? "five" : "four"}`}>
        <Kpi hero icon="wallet" label={`درآمد ماه ${name}`} value={cur.income} unit="؋" compare={[{ prev: prev.income, vs: vsPrev }, { prev: last.income, vs: vsLast }]} />
        <Kpi icon="receipt" label={`مصارف ماه ${name}`} value={cur.expenses} unit="؋" upIsGood={false} compare={[{ prev: prev.expenses, vs: vsPrev }, { prev: last.expenses, vs: vsLast }]} />
        <Kpi icon="chart" label={`سود خالص ماه ${name}`} value={net(cur)} unit="؋" compare={[{ prev: net(prev), vs: vsPrev }, { prev: net(last), vs: vsLast }]} />
        {canShares && <Kpi icon="banknote" label={`موجودی ماه ${name}`} value={left(cur)} unit="؋" note={`سود خالص ${fa(net(cur))} − برداشت شرکا ${fa(partnersTaken(cur))}`}
          compare={[{ prev: left(prev), vs: vsPrev }, { prev: left(last), vs: vsLast }]} />}
        <Kpi icon="plus" label={`ثبت‌نام جدید ${name}`} value={cur.new_members} unit="نفر" compare={[{ prev: prev.new_members, vs: vsPrev }, { prev: last.new_members, vs: vsLast }]} />
      </section>

      <section className="grid-2 even">
        <div className="glass panel-chart">
          <div className="panel-head">
            <h2>درآمد و مصارف روزانهٔ {name}</h2>
            <span className="muted small">{fa(n)} روز</span>
          </div>
          <TrendChart data={data.trend} label={`درآمد و مصارف روزانهٔ ماه ${name}`} every={5} />
        </div>
        <div className="glass">
          <div className="panel-head"><h2>مقایسهٔ ماه</h2></div>
          <div className="table-wrap flush">
            <table className="table compare">
              <thead>
                <tr><th /><th>{name} {yearNumber(now)}</th><th>{monthName(pm)}</th><th>{name} {yearNumber(ly)}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    <td><strong>{fa(r.get(cur))}</strong></td>
                    <td><Figure show={r.get(prev)} value={r.get(cur)} prev={r.get(prev)} upIsGood={r.upIsGood} /></td>
                    <td><Figure show={r.get(last)} value={r.get(cur)} prev={r.get(last)} upIsGood={r.upIsGood} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">هر ستون همان {fa(n)} روز اول ماه است. درصد زیر هر عدد نشان می‌دهد {name} امسال چقدر بیشتر یا کمتر از آن ماه است.
            روز فیس‌های اکسل از تاریخ عضویت روی دستگاه می‌آید: برای آخرین دورهٔ هر عضو دقیق است و برای ماه‌های پیش از آن با 30 روز به عقب حساب شده. فیسی که دوره‌ای برایش معلوم نیست در روز اول همان ماه می‌ماند.</p>
        </div>
      </section>

      <section className="grid-2 even">
        <div className="glass">
          <div className="panel-head"><h2>درآمد {name} به تفکیک بخش</h2></div>
          <CategoryBars data={asBars(cur.income_by_category)} empty="این ماه هنوز درآمدی ثبت نشده." />
        </div>
        <div className="glass">
          <div className="panel-head"><h2>مصارف {name} به تفکیک نوع</h2></div>
          <CategoryBars data={asBars(cur.expenses_by_category)} empty="این ماه هنوز مصرفی ثبت نشده." />
        </div>
      </section>
    </>
  );
}
