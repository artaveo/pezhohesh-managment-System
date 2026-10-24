import { useEffect, useState } from "react";
import { api, ApiError, type Dashboard as Data } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { sampleDashboard } from "../lib/sample";
import { fa, formatLong, formatShort, monthName, windowFor, yearNumber, type Period } from "../lib/solar";
import { Icon } from "../components/Icon";
import { DaysLeft } from "../components/DaysLeft";
import { TrendChart } from "../components/charts/TrendChart";
import { CategoryBars } from "../components/charts/CategoryBars";

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "امروز" },
  { id: "month", label: "این ماه" },
  { id: "year", label: "امسال" },
];

const VS: Record<Period, string> = { day: "نسبت به دیروز", month: "نسبت به همین روزهای ماه گذشته", year: "نسبت به همین مدت سال گذشته" };

export type Go = (page: "members" | "books") => void;

export function Dashboard({ go }: { go: Go }) {
  const [period, setPeriod] = useState<Period>("day");
  const [data, setData] = useState<Data | null>(null);
  const [sample, setSample] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    const params = { ...windowFor(period), period, month_from: windowFor("month").from, year_from: windowFor("year").from };
    api.dashboard(params, ctl.signal)
      .then((d) => { setData(d); setSample(false); setFailed(false); })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        // Sample numbers only while developing the screen; real users never see invented figures.
        if (import.meta.env.DEV && !(e instanceof ApiError)) {
          setData(sampleDashboard(period));
          setSample(true);
          return;
        }
        console.error("dashboard", e);
        setFailed(true);
      });
    return () => ctl.abort();
  }, [period, attempt]);

  const { user } = useAuth();
  const now = new Date();
  const P = PERIODS.find((p) => p.id === period)!.label;
  const title = period === "day" ? "گزارش امروز" : period === "month" ? `گزارش ماه ${monthName(now)}` : `گزارش سال ${yearNumber(now)}`;
  const k = data?.kpis;
  const profit = k ? k.income - k.expenses : 0;
  const profitPrev = k ? k.income_prev - k.expenses_prev : 0;
  const inc = data?.income_summary;

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <p className="eyebrow">{greeting(now)}{user ? `، ${user.full_name.split(" ")[0]}` : ""} · {formatLong(now)}</p>
          <h1>{title}</h1>
        </div>
        <div className="dash-tools">
          {sample && <span className="badge-sample" title="هستهٔ API در دسترس نیست؛ این اعداد نمونه هستند">دادهٔ نمونه</span>}
          <div className="segmented" role="tablist" aria-label="دورهٔ گزارش">
            {PERIODS.map((p) => (
              <button key={p.id} role="tab" aria-selected={p.id === period} className={p.id === period ? "on" : ""} onClick={() => setPeriod(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {failed ? (
        <div className="glass loading">
          <p className="muted">گزارش بارگذاری نشد؛ هستهٔ سیستم جواب نداد.</p>
          <button className="btn" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}>دوباره امتحان کن</button>
        </div>
      ) : !k || !inc ? <div className="glass loading">در حال بارگذاری…</div> : (
        <>
          {/* Income at a glance: fixed periods, the selected one highlighted with its change. */}
          <section className="income-strip" aria-label="درآمد قرائت‌خانه">
            <IncomeTile label="درآمد امروز" value={inc.today} on={period === "day"} delta={period === "day" ? <Delta value={k.income} prev={k.income_prev} /> : null} vs={VS.day} onClick={() => setPeriod("day")} />
            <IncomeTile label={`درآمد ماه ${monthName(now)}`} value={inc.month} on={period === "month"} delta={period === "month" ? <Delta value={k.income} prev={k.income_prev} /> : null} vs={VS.month} onClick={() => setPeriod("month")} />
            <IncomeTile label={`درآمد سال ${yearNumber(now)}`} value={inc.year} on={period === "year"} delta={period === "year" ? <Delta value={k.income} prev={k.income_prev} /> : null} vs={VS.year} onClick={() => setPeriod("year")} />
            <IncomeTile label="درآمد کل (از اولین ثبت)" value={inc.all_time} total />
          </section>

          <section className="kpis three">
            <Kpi icon="users" label={period === "day" ? "اعضای فعال امروز" : `اعضای فعال ${P}`} value={k.active_members} prev={k.active_members_prev} unit="نفر" vs={VS[period]} />
            <Kpi icon="plus" label={`ثبت‌نام جدید ${P}`} value={k.new_members} prev={k.new_members_prev} unit="نفر" vs={VS[period]} />
            <Kpi icon="fingerprint" label={`حاضری ${P}`} value={k.attendance} prev={k.attendance_prev} unit="ورود" vs={VS[period]} />
          </section>

          <section className="grid-2">
            <div className="glass panel-chart">
              <div className="panel-head">
                <h2>درآمد و مصارف روزانه</h2>
                <span className="muted small">30 روز اخیر</span>
              </div>
              <TrendChart data={data!.trend} />
            </div>
            <div className="glass panel-money">
              <div className="panel-head">
                <h2>خلاصهٔ مالی {P}</h2>
              </div>
              <dl className="money">
                <div><dt>درآمد {P}</dt><dd>{fa(k.income)} ؋</dd><Delta value={k.income} prev={k.income_prev} /></div>
                <div><dt>مصارف {P}</dt><dd>{fa(k.expenses)} ؋</dd><Delta value={k.expenses} prev={k.expenses_prev} upIsGood={false} /></div>
                <div className="net"><dt>سود خالص {P}</dt><dd>{fa(profit)} ؋</dd><Delta value={profit} prev={profitPrev} /></div>
              </dl>
              <p className="muted small">درصدها {VS[period]} است. سهم شرکا و معاش‌ها در صفحهٔ گزارش مالی جدا حساب می‌شود.</p>
            </div>
          </section>

          <section className="grid-3">
            <div className="glass">
              <div className="panel-head">
                <h2>عضویت‌های نزدیک به ختم</h2>
                <span className="muted small">{fa(data!.members_due_soon)} تا 5 روز · {fa(data!.members_expired)} تمام‌شده</span>
              </div>
              <ul className="attention">
                {data!.members_attention.map((m) => (
                  <li key={m.member_no} className={m.days_left < 0 ? "late" : ""}>
                    <span className="att-icon"><Icon name="clock" size={18} /></span>
                    <span className="att-main"><strong>{m.name}</strong> <span className="muted small">شمارهٔ {m.member_no} · ختم {formatShort(m.end_date)}</span></span>
                    <DaysLeft days={m.days_left} />
                  </li>
                ))}
                {!data!.members_attention.length && <li className="muted">عضویتی در 5 روز آینده ختم نمی‌شود.</li>}
              </ul>
              <button className="btn ghost see-all" onClick={() => go("members")}>
                مشاهدهٔ همه ({fa(data!.members_due_soon + data!.members_expired)})
              </button>
            </div>

            <div className="glass">
              <div className="panel-head">
                <h2>کتاب‌های امانتی</h2>
                <span className="muted small">{fa(data!.books_overdue)} دیرکرده · {fa(data!.books_due_soon)} تا 2 روز</span>
              </div>
              <ul className="attention">
                {data!.books_attention.map((b, i) => (
                  <li key={i} className={b.days_left < 0 ? "late" : ""}>
                    <span className="att-icon"><Icon name="book" size={18} /></span>
                    <span className="att-main"><strong>{b.book_title}</strong> <span className="muted small">{b.member_name} · شمارهٔ {b.member_no}</span></span>
                    <DaysLeft days={b.days_left} soon={2} />
                  </li>
                ))}
                {!data!.books_attention.length && <li className="muted">هیچ کتابی دیر نکرده.</li>}
              </ul>
              <button className="btn ghost see-all" onClick={() => go("books")}>
                مشاهدهٔ همه ({fa(data!.books_overdue + data!.books_due_soon)})
              </button>
            </div>

            <div className="glass">
              <div className="panel-head">
                <h2>درآمد {P} به تفکیک بخش</h2>
              </div>
              <CategoryBars data={data!.income_by_category} />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function IncomeTile({ label, value, on, total, delta, vs, onClick }: {
  label: string; value: number; on?: boolean; total?: boolean; delta?: React.ReactNode; vs?: string; onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`glass income-tile${on ? " on" : ""}${total ? " total" : ""}`} onClick={onClick} aria-pressed={onClick ? !!on : undefined}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{fa(value)} <small>؋</small></span>
      <span className="kpi-foot">{delta}{delta && <span className="muted small">{vs}</span>}</span>
    </Tag>
  );
}

function Kpi({ icon, label, value, prev, unit, vs }: { icon: string; label: string; value: number; prev: number; unit: string; vs: string }) {
  return (
    <div className="glass kpi">
      <div className="kpi-top">
        <span className="kpi-icon"><Icon name={icon} /></span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value">{fa(value)} <small>{unit}</small></div>
      <div className="kpi-foot"><Delta value={value} prev={prev} /> <span className="muted small">{vs}</span></div>
    </div>
  );
}

/** Change vs the previous window; arrow + sign carry the direction, color only reinforces it. */
function Delta({ value, prev, upIsGood = true }: { value: number; prev: number; upIsGood?: boolean }) {
  if (prev === 0 && value === 0) return <span className="delta flat">بدون تغییر</span>;
  if (prev === 0) return <span className="delta good"><Icon name="up" size={14} />جدید</span>;
  const pct = ((value - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="delta flat">بدون تغییر</span>;
  const up = pct > 0;
  const good = up === upIsGood;
  return (
    <span className={`delta ${good ? "good" : "bad"}`} aria-label={`${up ? "افزایش" : "کاهش"} ${fa(Math.abs(pct))} درصد`}>
      <Icon name={up ? "up" : "down"} size={14} />{fa(Math.abs(pct))}%
    </span>
  );
}

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "صبح بخیر" : h < 17 ? "روز بخیر" : "شب بخیر";
}
