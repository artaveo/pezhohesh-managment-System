import { useEffect, useState } from "react";
import { api, ApiError, type Dashboard as Data } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { sampleDashboard } from "../lib/sample";
import { fa, formatLong, formatShort, iso, monthName, windowFor, yearNumber, type Period } from "../lib/solar";
import { Icon } from "../components/Icon";
import { TrendChart } from "../components/charts/TrendChart";
import { CategoryBars } from "../components/charts/CategoryBars";

const PERIODS: { id: Period; label: string }[] = [
  { id: "day", label: "امروز" },
  { id: "month", label: "این ماه" },
  { id: "year", label: "امسال" },
];

const VS: Record<Period, string> = { day: "نسبت به دیروز", month: "نسبت به ماه گذشته", year: "نسبت به سال گذشته" };

export function Dashboard() {
  const [period, setPeriod] = useState<Period>("day");
  const [data, setData] = useState<Data | null>(null);
  const [sample, setSample] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    api.dashboard(windowFor(period), ctl.signal)
      .then((d) => { setData(d); setSample(false); })
      .catch((e) => {
        if (ctl.signal.aborted || e instanceof ApiError) return;
        console.warn("dashboard API unreachable, showing sample data", e);
        setData(sampleDashboard(period));
        setSample(true);
      });
    return () => ctl.abort();
  }, [period]);

  const { user } = useAuth();
  const now = new Date();
  const title = period === "day" ? "گزارش امروز" : period === "month" ? `گزارش ماه ${monthName(now)}` : `گزارش سال ${yearNumber(now)}`;
  const k = data?.kpis;
  const profit = k ? k.income - k.expenses : 0;
  const profitPrev = k ? k.income_prev - k.expenses_prev : 0;

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

      {!k ? <div className="glass loading">در حال بارگذاری…</div> : (
        <>
          <section className="kpis">
            <Kpi hero icon="wallet" label="درآمد" value={k.income} prev={k.income_prev} unit="؋" vs={VS[period]} />
            <Kpi icon="users" label="اعضای فعال" value={k.active_members} prev={k.active_members_prev} unit="نفر" vs={VS[period]} />
            <Kpi icon="plus" label="ثبت‌نام جدید" value={k.new_members} prev={k.new_members_prev} unit="نفر" vs={VS[period]} />
            <Kpi icon="fingerprint" label="حاضری" value={k.attendance} prev={k.attendance_prev} unit="ورود" vs={VS[period]} />
          </section>

          <section className="grid-2">
            <div className="glass panel-chart">
              <div className="panel-head">
                <h2>درآمد و مصارف</h2>
                <span className="muted small">۳۰ روز اخیر</span>
              </div>
              <TrendChart data={data!.trend} />
            </div>
            <div className="glass panel-money">
              <h2>خلاصهٔ مالی</h2>
              <dl className="money">
                <div><dt>درآمد</dt><dd>{fa(k.income)} ؋</dd></div>
                <div><dt>مصارف</dt><dd>{fa(k.expenses)} ؋</dd><Delta value={k.expenses} prev={k.expenses_prev} upIsGood={false} /></div>
                <div className="net"><dt>سود خالص</dt><dd>{fa(profit)} ؋</dd><Delta value={profit} prev={profitPrev} /></div>
              </dl>
              <p className="muted small">سهم شرکا و معاش‌ها در صفحهٔ گزارش مالی جدا حساب می‌شود.</p>
            </div>
          </section>

          <section className="grid-2">
            <div className="glass">
              <div className="panel-head">
                <h2>درآمد به تفکیک بخش</h2>
                <span className="muted small">{PERIODS.find((p) => p.id === period)!.label}</span>
              </div>
              <CategoryBars data={data!.income_by_category} />
            </div>
            <div className="glass">
              <div className="panel-head">
                <h2>نیاز به توجه</h2>
              </div>
              <ul className="attention">
                {data!.overdue_books > 0 && (
                  <li className="warn">
                    <span className="att-icon"><Icon name="book" size={18} /></span>
                    <span><strong>{fa(data!.overdue_books)} کتاب</strong> از موعد برگشت گذشته</span>
                  </li>
                )}
                {data!.expiring.map((m) => (
                  <li key={m.member_no}>
                    <span className="att-icon"><Icon name="clock" size={18} /></span>
                    <span><strong>{m.name}</strong> <span className="muted">· شمارهٔ {fa(m.member_no)}</span></span>
                    <span className="due">{expiresLabel(m.end_date)}</span>
                  </li>
                ))}
                {!data!.expiring.length && !data!.overdue_books && <li className="muted">همه چیز مرتب است.</li>}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, prev, unit, vs, hero }: { icon: string; label: string; value: number; prev: number; unit: string; vs: string; hero?: boolean }) {
  return (
    <div className={`glass kpi${hero ? " hero" : ""}`}>
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
      <Icon name={up ? "up" : "down"} size={14} />{fa(Math.abs(pct))}٪
    </span>
  );
}

function greeting(d: Date) {
  const h = d.getHours();
  return h < 12 ? "صبح بخیر" : h < 17 ? "روز بخیر" : "شب بخیر";
}

function expiresLabel(end: string) {
  const days = Math.round((new Date(end + "T00:00:00").getTime() - new Date(iso(new Date()) + "T00:00:00").getTime()) / 864e5);
  return days <= 0 ? "امروز ختم می‌شود" : days === 1 ? "فردا ختم می‌شود" : `${fa(days)} روز دیگر · ${formatShort(end)}`;
}
